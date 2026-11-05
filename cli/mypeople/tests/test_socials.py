import json

import pytest

from mypeople import cli, db, identity, llm, profile_evidence, socials
from mypeople.events import add_event
from mypeople.profile_urls import enumeration_site, username_for


def make_person(conn):
    pid = identity.resolve(conn, [("email", "chris@capitalone.com"), ("email", "chris@gmail.com")], "Chris Wren", "test")
    add_event(conn, pid, "job", "Works as a recruiter at Capital One.", "2025-01", 0.9, "imessage")
    add_event(conn, pid, "move", "Lives in Richmond, Virginia.", "2024", 0.9, "imessage")
    conn.commit()
    return pid


def page(url, **overrides):
    return {"url": url, "access": "ok", "title": "Chris Wren",
            "description": "Recruiter at Capital One. Lives in Richmond, Virginia.",
            "identity_links": [], "links": [], **overrides}


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(profile_evidence, "fetch", page)


def fake_search(query, **options):
    fake_search.queries.append((query, options))
    if options.get("category") == "people":
        return [{"url": "https://linkedin.com/in/chris-wren", "title": "Chris Wren", "highlights": ["Recruiter at Capital One, Richmond"]},
                {"url": "https://linkedin.com/in/chris-wren-2", "title": "Chris Wren", "highlights": ["Plumber in Ohio"]},
                {"url": "https://randomblog.example/chris", "title": "Chris", "highlights": ["not a profile site"]}], 0.007
    return [{"url": "https://github.com/cwren", "title": "cwren", "highlights": ["Richmond, VA"]}], 0.007


def matches():
    return [socials.EvidenceMatch(fact_id="fact:0", evidence_id="page", quote="Recruiter at Capital One"),
            socials.EvidenceMatch(fact_id="fact:1", evidence_id="page", quote="Lives in Richmond, Virginia")]


def judge(ctx, found):
    judge.seen = [c["url"] for c in found]
    return [socials.Verdict(url=found[0]["url"], assessment="supported", reason="Capital One and Richmond", matches=matches()),
            socials.Verdict(url=found[1]["url"], assessment="conflicting", reason="Explicit contradiction", matches=matches()[:1]),
            socials.Verdict(url=found[2]["url"], assessment="supported", reason="Same handle", matches=[])]


def test_find_keeps_assessments_separate_from_confirmation(conn):
    fake_search.queries = []
    pid = make_person(conn)
    ctx = socials.context(conn, pid)
    assert ctx["email_domains"] == ["capitalone.com"]
    suggested, cost = socials.find(conn, pid, search=fake_search, judge=judge)
    query, _ = fake_search.queries[0]
    assert query.startswith("Chris Wren, ") and "Capital One" in query and "@" not in query
    assert "https://randomblog.example/chris" not in judge.seen
    assert suggested == 2 and round(cost, 3) == 0.014
    supported, possible = socials.suggestions(conn)
    assert supported["assessment"] == "supported" and possible["assessment"] == "possible"
    assert len(socials.suggestions(conn, include_diagnostics=True)) == 3
    assert socials.confirmed(conn, pid) == []
    socials.set_status(conn, supported["id"], "confirmed")
    assert [c["url"] for c in socials.confirmed(conn, pid)] == [supported["url"]]
    assert socials.to_search(conn, 10) == []
    stored = json.loads(supported['evidence'])
    assert len(stored['matches']) == 2 and stored['page']['access'] == 'ok'


def test_ordinary_exa_flow_verifies_twenty_candidates_in_one_batch(conn, monkeypatch):
    pid = make_person(conn)
    queries, calls = [], []
    def search(query, **options):
        queries.append(options)
        offset = 0 if options.get('category') else 10
        return [{'url':f'https://github.com/example{i:02}','title':'Chris Wren','highlights':['Capital One, Richmond']}
                for i in range(offset,offset+10)], 0.007
    def complete(system,user,**kwargs):
        batch=json.loads(user)
        calls.append(batch)
        return socials.Verdicts(verdicts=[socials.Verdict(url=c['candidate_url'],assessment='supported',
            reason='Two independent facts',matches=matches()) for c in batch['candidates']]).model_dump_json()
    monkeypatch.setattr(llm,'complete',complete)
    n,cost=socials.find(conn,pid,search=search)
    assert len(queries)==2 and len(calls)==1 and len(calls[0]['candidates'])==20
    assert n==20 and round(cost,3)==0.014
    assert not socials.confirmed(conn,pid)


def test_searchable_names():
    assert socials.searchable("Chris Wren") and socials.searchable("María Belderrain")
    assert not socials.searchable("Kevin") and not socials.searchable("+15551234567") and not socials.searchable("bob@x.com")
    assert socials.site("https://twitter.com/x") == "x"


@pytest.mark.parametrize("left,right", [
    ("https://www.linkedin.com/in/John-Naylor/", "https://linkedin.com/in/john-naylor"),
    ("https://linkedin.com/posts/john-naylor_wine-recommender-activity-69055", "https://linkedin.com/in/john-naylor"),
    ("https://medium.com/@jonaylor89/about", "https://medium.com/@jonaylor89"),
    ("https://github.com/jonaylor89?tab=achievements", "https://github.com/jonaylor89"),
    ("https://gist.github.com/JONAYLOR89", "https://github.com/jonaylor89"),
    ("https://twitter.com/jonaylor89/status/123", "https://x.com/jonaylor89"),
    ("https://threads.net/@Jonaylor89", "https://threads.com/@jonaylor89"),
    ("https://youtube.com/user/FrankieBiggz", "https://youtube.com/user/frankiebiggz"),
    ("https://thefizz.substack.com/p/the-fizz-84", "https://thefizz.substack.com"),
])
def test_profile_urls_collapse_variants(left, right):
    assert socials.profile_url(left) == right


@pytest.mark.parametrize("url", [
    "https://youtube.com/watch?v=5OSF", "https://instagram.com/p/abc/",
    "https://medium.com/rough-draft-ventures/intro", "https://camas.github.io/reddit-search/",
    "https://github.com.evil.example/cwren", "https://alice:secret@github.com/cwren",
    "https://github.com:123/cwren", "https://github.com:0/cwren", "https://github.com/foo%2fbar",
])
def test_non_profile_urls_are_rejected(url):
    assert socials.profile_url(url) is None


@pytest.mark.parametrize("url,handle", [
    ("https://youtube.com/user/FrankieBiggz", "frankiebiggz"),
    ("https://youtube.com/c/FrankieBiggz", "frankiebiggz"),
    ("https://youtube.com/@FrankieBiggz", "frankiebiggz"),
    ("https://youtube.com/channel/UCaAbBcC", None),
    ("https://tiktok.com/@cwren", "cwren"),
    ("https://threads.com/@cwren", "cwren"),
    ("https://bsky.app/profile/did:plc:abc", None),
    ("https://linkedin.com/in/chris-wren", None),
])
def test_reusable_handles(url, handle):
    assert username_for(url) == handle
    if "/channel/" in url:
        assert socials.profile_url(url).endswith("UCaAbBcC")


def test_channel_ids_are_not_case_folded_or_conflated_with_handles():
    assert socials.profile_url("https://youtube.com/channel/UCaAbBcC") != socials.profile_url("https://youtube.com/channel/ucaabbcc")
    assert socials.profile_url("https://youtube.com/user/cwren") != socials.profile_url("https://youtube.com/@cwren")


@pytest.mark.parametrize("template", ["https://reddit.com/user/{}", "https://camas.github.io/reddit-search/{}",
                                    "https://linkedin.com/in/{}", "https://gist.github.com/{username}"])
def test_scanners_exclude_unusable_families(template):
    assert not enumeration_site(template)


def candidate(url="https://github.com/cwren", **evidence):
    return {"url": url, "evidence": {"page": page(url), "index": "", "trusted_links": [], **evidence}}


def test_name_handle_and_scanner_agreement_do_not_support_ownership(monkeypatch):
    ctx = {"name": "Chris Wren", "aliases": [], "facts": [], "email_domains": []}
    monkeypatch.setattr(llm, "complete", lambda *a, **kw: pytest.fail("must abstain without facts"))
    c = candidate()
    c["sources"] = ["sherlock", "maigret"]
    assert socials.verify(ctx, [c])[0].assessment == "possible"


def test_quotes_and_independent_fact_categories_are_required(conn):
    ctx = socials.context(conn, make_person(conn))
    c = candidate(page=page("", title="cwren"))  # No full-name shortcut for this multi-fact test.
    good = socials.Verdict(url=c["url"], assessment="supported", reason="Two independent facts", matches=matches())
    assert socials.ground(ctx, c, good).assessment == "supported"
    invented = good.model_copy(update={"matches": [m.model_copy(update={"quote": "This quote is entirely invented"}) for m in matches()]})
    assert socials.ground(ctx, c, invented).assessment == "possible"
    ctx["fact_types"] = ["job", "job"]
    assert socials.ground(ctx, c, good).assessment == "possible"


def test_a_real_fact_and_employer_domain_are_not_two_categories():
    ctx = {"facts": ["Works at Capital One"], "fact_types": ["job"], "email_domains": ["capitalone.com"]}
    c = candidate(page=page("", description="Works at Capital One. Website capitalone.com."))
    verdict = socials.Verdict(url=c["url"], assessment="supported", reason="Employer twice", matches=[
        socials.EvidenceMatch(fact_id="fact:0", evidence_id="page", quote="Works at Capital One"),
        socials.EvidenceMatch(fact_id="domain:0", evidence_id="page", quote="Website capitalone.com")])
    assert socials.ground(ctx, c, verdict).assessment == "possible"


@pytest.mark.parametrize("access", ["not_found", "private", "blocked", "empty", "error"])
def test_inaccessible_pages_cannot_be_promoted(conn, access):
    ctx = socials.context(conn, make_person(conn))
    c = candidate(page=page("", access=access))
    proposed = socials.Verdict(url=c["url"], assessment="supported", reason="Same handle", matches=matches())
    assert socials.ground(ctx, c, proposed).assessment == "inaccessible"
    c["evidence"]["index"] = "Historical public profile metadata"
    assert socials.ground(ctx, c, proposed).assessment == ("inaccessible" if access in ("private", "not_found") else "possible")


def test_one_batch_keeps_citations_candidate_local_and_order_is_irrelevant(conn, monkeypatch):
    ctx = socials.context(conn, make_person(conn))
    seen = []

    def complete(system, user, **kwargs):
        data = json.loads(user)
        seen.append(data)
        # Deliberately try borrowing A's valid quotes for every candidate.
        return socials.Verdicts(verdicts=[
            socials.Verdict(url=c['candidate_url'], assessment='supported', reason='Borrowed facts', matches=matches())
            for c in data['candidates']]).model_dump_json()

    monkeypatch.setattr(llm, 'complete', complete)
    a = candidate()
    b = candidate("https://instagram.com/cwren", page=page("", title="CWREN_MARKER", description="Only a shared handle"))
    first = {v.url: v.assessment for v in socials.verify(ctx, [a, b])}
    second = {v.url: v.assessment for v in socials.verify(ctx, [b, a])}
    assert first == second == {a['url']: 'supported', b['url']: 'possible'}
    assert len(seen) == 2  # ONE call for each verification invocation, not each URL.
    assert seen[0] == seen[1]
    assert len(seen[0]['candidates']) == 2


@pytest.mark.parametrize('count', [1, 10, 20, 25])
def test_verification_has_one_call_budget_and_bounded_batch(conn, monkeypatch, count):
    ctx = socials.context(conn, make_person(conn))
    calls = []
    def complete(system, user, **kwargs):
        batch = json.loads(user)
        calls.append(batch)
        return socials.Verdicts(verdicts=[
            socials.Verdict(url=c['candidate_url'], assessment='supported', reason='Known facts', matches=matches())
            for c in batch['candidates']]).model_dump_json()
    monkeypatch.setattr(llm, 'complete', complete)
    found = [candidate(f'https://github.com/cwren{i:02}') for i in range(count)]
    result = socials.verify(ctx, found)
    assert len(calls) == 1
    assert len(calls[0]['candidates']) == min(count, socials.MAX_VERIFY_CANDIDATES)
    assert sum(v.assessment == 'supported' for v in result) == min(count, socials.MAX_VERIFY_CANDIDATES)
    assert all(v.assessment == 'possible' for v in result[socials.MAX_VERIFY_CANDIDATES:])


def test_character_budget_never_creates_extra_model_batches(conn, monkeypatch):
    ctx = socials.context(conn, make_person(conn))
    calls = []
    def complete(system, user, **kwargs):
        calls.append(user)
        return '{"verdicts":[]}'
    monkeypatch.setattr(llm, 'complete', complete)
    found = [candidate(f'https://github.com/cwren{i}', index='x' * 15_000) for i in range(10)]
    assert all(v.assessment == 'possible' for v in socials.verify(ctx, found))
    assert len(calls) == 1 and len(calls[0]) <= socials.MAX_VERIFY_CHARS


def test_invalid_json_has_one_batch_retry_not_per_candidate(conn, monkeypatch):
    ctx = socials.context(conn, make_person(conn))
    calls = []
    def complete(*a, **kw):
        calls.append(True)
        return 'not json'
    monkeypatch.setattr(llm, 'complete', complete)
    with pytest.raises(llm.LLMError):
        socials.verify(ctx, [candidate(f'https://github.com/cwren{i}') for i in range(20)])
    assert len(calls) == 2


def test_missing_duplicate_and_unrequested_verdicts_cannot_promote(conn, monkeypatch):
    ctx = socials.context(conn, make_person(conn))
    a, b, c = [candidate(f'https://github.com/{name}') for name in ('a','b','c')]
    good = lambda url: socials.Verdict(url=url, assessment='supported', reason='Facts', matches=matches())
    monkeypatch.setattr(llm, 'complete', lambda *a, **kw: socials.Verdicts(
        verdicts=[good('https://github.com/a'), good('https://github.com/a'), good('https://github.com/unknown')]).model_dump_json())
    assert all(v.assessment == 'possible' for v in socials.verify(ctx, [a,b,c]))


@pytest.mark.parametrize('kind,fact,description,quote', [
    ('job', 'Works as a recruiter at Capital One (Jan 2025)', 'Recruiter at Capital One', 'Recruiter at Capital One'),
    ('education', 'Graduated from MIT (2020)', 'MIT', 'MIT'),
])
def test_matching_full_name_and_one_specific_fact_can_be_supported(monkeypatch, kind, fact, description, quote):
    ctx = {'name':'Chris Wren', 'aliases':[], 'facts':[fact], 'fact_types':[kind], 'email_domains':[]}
    c = candidate(page=page('', description=description))
    calls = []
    def complete(*a, **kw):
        calls.append(True)
        return socials.Verdicts(verdicts=[socials.Verdict(url=c['url'], assessment='supported', reason='Specific fact',
            matches=[socials.EvidenceMatch(fact_id='fact:0', evidence_id='page', quote=quote)])]).model_dump_json()
    monkeypatch.setattr(llm, 'complete', complete)
    result = socials.verify(ctx, [c])
    assert len(calls) == 1 and result[0].assessment == 'supported'
    assert 'Full profile name' in result[0].reason


@pytest.mark.parametrize('kind,fact', [
    ('move','Lives in Richmond'), ('job','Works in tech'), ('job','Works at a company'), ('education','Studies at a university'), ('education','Studies at night'),
])
def test_generic_single_facts_do_not_justify_ownership_or_a_model_call(monkeypatch, kind, fact):
    ctx = {'name':'Chris Wren','aliases':[],'facts':[fact],'fact_types':[kind],'email_domains':[]}
    monkeypatch.setattr(llm,'complete',lambda *a,**kw:pytest.fail('generic single fact should abstain'))
    assert socials.verify(ctx,[candidate()])[0].assessment == 'possible'


def test_single_fact_requires_owner_name_not_just_indexed_mentions():
    ctx = {'name':'Chris Wren','aliases':[],'facts':['Works at Capital One'],'fact_types':['job'],'email_domains':[]}
    c = candidate(page=page('',title='Different Owner'), index='Chris Wren, recruiter at Capital One')
    verdict = socials.Verdict(url=c['url'],assessment='supported',reason='Mention in index',
        matches=[socials.EvidenceMatch(fact_id='fact:0',evidence_id='index',quote='recruiter at Capital One')])
    assert socials.ground(ctx,c,verdict).assessment == 'possible'


def test_only_explicit_identity_links_from_confirmed_anchors_support(conn, monkeypatch):
    pid = make_person(conn)
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status) VALUES (?, 'github', 'https://github.com/cwren', 1, 'confirmed')", (pid,))
    def fetch(url, timeout):
        return page(url, identity_links=["https://instagram.com/cwren"] if 'github' in url else [])
    monkeypatch.setattr(profile_evidence, 'fetch', fetch)
    n, cost = socials.find(conn, pid, exa=False, osint=lambda *a: [{'url': 'https://instagram.com/cwren', 'sources': []}])
    assert (n, cost) == (1, 0.0)
    assert socials.suggestions(conn)[0]['assessment'] == 'supported'
    assert conn.execute('SELECT count(*) FROM profile_searches').fetchone()[0] == 0


def test_rescans_preserve_manual_decisions_and_cache_metadata(conn, monkeypatch):
    pid = make_person(conn)
    calls = []
    def fetch(url, timeout):
        calls.append(url)
        return page(url)
    monkeypatch.setattr(profile_evidence, 'fetch', fetch)
    source = lambda *a: [{'url': 'https://threads.net/@cwren', 'sources': []}]
    socials.find(conn, pid, exa=False, osint=source, judge=lambda *a: [])
    row = socials.suggestions(conn)[0]
    socials.find(conn, pid, exa=False, osint=source, judge=lambda *a: [])
    assert len(calls) == 1
    socials.set_status(conn, row['id'], 'rejected')
    socials.find(conn, pid, exa=False, osint=source, judge=lambda *a: pytest.fail('must not re-judge rejected alias'))
    assert len(calls) == 1 and not socials.suggestions(conn)
    assert conn.execute('SELECT status FROM profiles').fetchone()[0] == 'rejected'


def test_alias_upgrade_preserves_confirmations(conn):
    pid = make_person(conn)
    for url, status in [('https://threads.net/@CWREN', 'confirmed'), ('https://threads.com/@cwren', 'suggested')]:
        conn.execute('INSERT INTO profiles (person_id, site, url, confidence, status) VALUES (?, ?, ?, 1, ?)', (pid, 'threads', url, status))
    db.normalize_profiles(conn)
    [row] = conn.execute('SELECT * FROM profiles').fetchall()
    assert row['url'] == 'https://threads.com/@cwren' and row['status'] == 'confirmed'
    assert len(json.loads(row['sources'])) == 2


def test_profiles_and_their_evidence_follow_merges(conn):
    pid = make_person(conn)
    other = identity.create_person(conn, 'Chris W')
    socials.find(conn, other, exa=False, osint=lambda *a: [{'url': 'https://github.com/cwren', 'sources': []}], judge=lambda *a: [])
    identity.merge(conn, pid, other)
    [row] = socials.suggestions(conn)
    assert row['person_id'] == pid and json.loads(row['evidence'])['page']['access'] == 'ok'


def test_review_all_exposes_diagnostics_but_never_auto_confirms(conn, monkeypatch, capsys):
    pid = make_person(conn)
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, assessment) VALUES (?, 'github', 'https://github.com/cwren', 0, 'inaccessible')", (pid,))
    assert not socials.suggestions(conn)
    monkeypatch.setattr('builtins.input', lambda *a: 's')
    cli.cmd_socials(conn, cli.build_parser().parse_args(['socials', 'review', '--all']))
    assert '[inaccessible]' in capsys.readouterr().out
    assert not socials.confirmed(conn, pid)


@pytest.mark.parametrize('old_suggestion', [False, True])
def test_youtube_alias_is_deduped_only_with_matching_canonical_channel_ids(conn, monkeypatch, old_suggestion):
    pid = make_person(conn)
    seed = 'https://youtube.com/user/legacyhandle'
    alias = 'https://youtube.com/@currenthandle'
    channel = 'https://youtube.com/channel/UC' + 'a' * 22
    conn.execute("INSERT INTO profiles (person_id,site,url,confidence,status) VALUES (?, 'youtube', ?, 1, 'confirmed')", (pid,seed))
    if old_suggestion:
        conn.execute("INSERT INTO profiles (person_id,site,url,confidence) VALUES (?, 'youtube', ?, 0)", (pid,alias))
    monkeypatch.setattr(profile_evidence, 'fetch', lambda url, timeout: page(url, canonical_url=channel))
    n,cost = socials.find(conn,pid,exa=False,osint=lambda *a:[{'url':alias}],
                         judge=lambda *a:pytest.fail('confirmed aliases must not be judged'))
    assert (n,cost) == (0,0.0)
    [row] = conn.execute('SELECT * FROM profiles').fetchall()
    assert row['url'] == seed and row['status'] == 'confirmed'
    assert {'source':'canonical_alias','url':alias,'canonical_url':channel} in json.loads(row['sources'])


@pytest.mark.parametrize('candidate_channel', [None, 'https://youtube.com/channel/UC' + 'A' * 22])
def test_same_handle_or_differently_cased_channel_id_does_not_prove_an_alias(conn, monkeypatch, candidate_channel):
    pid = make_person(conn)
    seed = 'https://youtube.com/user/example'
    alias = 'https://youtube.com/@example'
    channel = 'https://youtube.com/channel/UC' + 'a' * 22
    conn.execute("INSERT INTO profiles (person_id,site,url,confidence,status) VALUES (?, 'youtube', ?, 1, 'confirmed')", (pid,seed))
    def fetch(url,timeout):
        return page(url, canonical_url=channel if url==seed else candidate_channel)
    monkeypatch.setattr(profile_evidence, 'fetch', fetch)
    n,_ = socials.find(conn,pid,exa=False,osint=lambda *a:[{'url':alias}],judge=lambda *a:[])
    assert n==1 and socials.suggestions(conn)[0]['url']==alias


def test_youtube_alias_dedup_does_not_override_an_explicit_rejection(conn, monkeypatch):
    pid = make_person(conn)
    for url,status in [('https://youtube.com/user/example','confirmed'),('https://youtube.com/@example','rejected')]:
        conn.execute("INSERT INTO profiles (person_id,site,url,confidence,status) VALUES (?, 'youtube', ?, 1, ?)",(pid,url,status))
    monkeypatch.setattr(profile_evidence, 'fetch', lambda *a,**kw:pytest.fail('must not refetch a rejected lead'))
    n,_ = socials.find(conn,pid,exa=False,osint=lambda *a:[{'url':'https://youtube.com/@example'}],judge=lambda *a:[])
    assert n==0 and len(conn.execute('SELECT * FROM profiles').fetchall())==2
    assert conn.execute("SELECT status FROM profiles WHERE url='https://youtube.com/@example'").fetchone()[0]=='rejected'


def test_schema_upgrade_is_repeatable_and_preserves_alias_decisions(conn):
    pid = make_person(conn)
    conn.executescript('''DROP TABLE profiles;
        CREATE TABLE profiles (
            id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL, site TEXT NOT NULL, url TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '', snippet TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL,
            reason TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'suggested',
            found_at TEXT NOT NULL DEFAULT '', UNIQUE(person_id, url));''')
    for url, status in [('https://gist.github.com/CWREN', 'confirmed'), ('https://github.com/cwren', 'suggested')]:
        conn.execute('INSERT INTO profiles (person_id,site,url,confidence,status) VALUES (?, ?, ?, 0.9, ?)', (pid,'github',url,status))
    db._migrate(conn)
    db._migrate(conn)
    [row] = conn.execute('SELECT * FROM profiles').fetchall()
    assert row['url'] == 'https://github.com/cwren' and row['status'] == 'confirmed'
    assert row['assessment'] == 'possible' and json.loads(row['evidence']) == {}
    assert len(json.loads(row['sources'])) == 2


def test_person_merges_do_not_drop_confirmed_profile_on_collision(conn):
    keep = make_person(conn)
    drop = identity.create_person(conn, 'Chris W')
    for pid, url, status in [(keep, 'https://threads.com/@cwren', 'suggested'), (drop, 'https://threads.net/@CWREN', 'confirmed')]:
        conn.execute('INSERT INTO profiles (person_id,site,url,confidence,status) VALUES (?, ?, ?, 1, ?)', (pid,'threads',url,status))
    identity.merge(conn, keep, drop)
    [row] = conn.execute('SELECT * FROM profiles').fetchall()
    assert row['person_id'] == keep and row['status'] == 'confirmed'
    assert row['url'] == 'https://threads.com/@cwren'
