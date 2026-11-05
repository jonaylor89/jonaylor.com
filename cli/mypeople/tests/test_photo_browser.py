from pathlib import Path
from types import SimpleNamespace

from mypeople.photo_browser import PhotoBrowser
from tests.test_social_photos import IG, LI, IG_IMAGE, LI_IMAGE


class Page:
    def __init__(self, url, data=None, images=None):
        self.url = url
        self.data = data or {}
        self.images = images or []
        self.closed = False
        self.evaluated = False
        self.selector = None
        self.first = self
        self.navigations = []

    def goto(self, url, **kwargs):
        self.navigations.append(url)

    def evaluate(self, script, handle):
        self.evaluated = True
        assert handle == "alice"
        return self.data

    def locator(self, selector):
        self.selector = selector
        return self

    def wait_for(self, **kwargs):
        pass

    def evaluate_all(self, script):
        return self.images

    def is_closed(self):
        return self.closed

    def close(self):
        self.closed = True


def browser(page):
    b = PhotoBrowser()
    b.error = RuntimeError
    b.context = lambda source: SimpleNamespace(new_page=lambda: page)
    return b


def test_browser_login_redirect_does_not_read_other_account():
    page = Page("https://www.linkedin.com/login")
    assert browser(page).image(LI)[0] is None
    assert not page.evaluated and page.closed


def test_browser_uses_only_matching_api_avatar():
    page = Page(IG, {"data": {"user": {"username": "ALICE", "profile_pic_url_hd": IG_IMAGE}}})
    assert browser(page).image(IG) == (IG_IMAGE, "dedicated browser API")
    assert page.closed
    assert page.navigations == ["https://www.instagram.com/"]


def test_browser_instagram_dom_fallback_scoped_to_header():
    page = Page(IG, images=["https://evil.example/a", IG_IMAGE])
    assert browser(page).image(IG) == (IG_IMAGE, "dedicated browser profile")
    assert page.selector == "header img"
    assert page.navigations == ["https://www.instagram.com/", "https://www.instagram.com/alice/"]


def test_browser_linkedin_only_looks_for_top_card_images():
    page = Page(LI, images=[LI_IMAGE])
    assert browser(page).image(LI) == (LI_IMAGE, "dedicated browser profile")
    assert '[data-view-name="profile-top-card-member-photo"] img' in page.selector
    assert '[componentkey="topcard-logo-image-referencekey"] img' in page.selector
    assert page.navigations == ["https://www.linkedin.com/in/alice/"]


def test_browser_closes_page_on_timeout():
    page = Page(LI)
    def fail(*a, **kw):
        raise RuntimeError("navigation failed")
    page.goto = fail
    assert browser(page).image(LI)[0] is None
    assert page.closed


def test_login_uses_instagram_home_not_failing_login_route():
    page = Page("https://www.instagram.com/")
    prompts = []
    browser(page).login("instagram", prompt=prompts.append)
    assert page.navigations == ["https://www.instagram.com/"]
    assert len(prompts) == 1 and page.closed


def test_browser_default_avatar_rejected():
    from mypeople.social_photos import instagram_image, image_allowed
    assert instagram_image({"data": {"user": {"username": "alice", "has_anonymous_profile_picture": True,
                                             "profile_pic_url_hd": IG_IMAGE}}}, "alice") is None
    assert not image_allowed("https://static.cdninstagram.com/rsrc.php/default.png", "instagram")


def test_browser_session_is_separate_private_and_closed(tmp_path):
    b = PhotoBrowser(tmp_path / "sessions")
    b.error = RuntimeError
    closed = []
    calls = []
    def launch(path, **kwargs):
        calls.append((path, kwargs))
        return SimpleNamespace(close=lambda: closed.append(True))
    b.playwright = SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))
    context = b.context("instagram")
    assert context is b.context("instagram") and len(calls) == 1
    assert Path(calls[0][0]) == tmp_path / "sessions" / "instagram"
    assert calls[0][1]["headless"] is False
    assert (Path(calls[0][0]).stat().st_mode & 0o777) == 0o700
    b.__exit__(None, None, None)
    assert closed == [True]
