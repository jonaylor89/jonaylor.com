# Project brief: a relationship memory app

## What it is
A personal app that keeps a living, up-to-date understanding of everyone in the user's life, and surfaces the right moment to reach out. Think of a contacts app crossed with a personal CRM crossed with a thoughtful friend. It's for everyone, not just business users: friends, family, and professional contacts all live in it.

## The problem
Address books store static fields (name, phone, birthday). Life happens in events: new jobs, weddings, babies, moves, trips, losses, milestones. People miss these and slowly lose touch. Birthday reminders are the only version of this that exists today, because a birthday is the only event an address book stores.

## The core idea
Continuously gather signals about each person from every source the user has access to, model them as dated events on a per-person timeline, model the state of each relationship, and surface a small number of well-timed, context-rich prompts.

## Core concepts
- **Person**: one identity merged across all sources (address book entries, email addresses, phone numbers, social handles).
- **Event**: a dated fact about a person (job change, move, wedding, birth, trip, loss, achievement, upcoming plan). Every event carries its type, value, date, source, and confidence. A person's "current" profile is derived from their events; nothing is stored as a bare field.
- **Interaction**: any contact between the user and a person (message, email, call, meeting, photo together). Mostly metadata: who, when, which channel.
- **Relationship**: closeness, category (family, friend, work…), natural contact cadence, trend (growing or drifting), open threads and promises. Inferred automatically; the user can override anything.
- **Moment**: a surfaced prompt with a reason and context. "Marcus started at Figma Monday; last time you talked he was nervous about leaving his team."

## Where signals come from
- The user's own communications: email, messages, calls, calendar, photos.
- Open web and public social sources: posts, company pages, news, personal sites, platform APIs where they exist.
- Quick capture from the user: share sheet, voice notes after a conversation, browser extension.
- Imports from existing address books and platform data exports.

LLMs do the extraction: unstructured text in, structured events out, attributed to the right person.

## What the user experiences
- A short daily set of moments (life events, upcoming things, drifting relationships), each with a reason.
- Location-aware prompts ("you're in Austin, three people you love live here").
- Anniversaries of important events, including hard ones.
- Gift and introduction suggestions grounded in what it knows.
- Natural-language questions ("who do I know in Lisbon?", "what's Priya's daughter's name?").
- A year-in-review of the user's relationships.
- It suggests and drafts; it never sends anything on the user's behalf.

## Platforms
iOS, Android, web, desktop, with continuous sync. Ideally it shows up inside existing surfaces (notifications, share sheet, caller ID, widgets) as much as inside its own app.

## Principles
- Every fact shows its source.
- Private by default; the user owns the data.
- Few, high-quality prompts. Silence beats noise.
- The goal is better relationships, not more messages sent.

## The hard problems
1. **Identity resolution**: merging one person across many sources, and attaching a public signal to the right "John Smith."
2. **Event extraction quality**: accurate types, dates, and confidence from messy text.
3. **Relationship modeling**: inferring closeness and natural cadence from interaction history.
4. **Moment ranking**: choosing the few things worth surfacing on a given day.
5. **Source access**: email, calendar, contacts, and messages (iMessage in particular has no API), plus public-web monitoring.
6. **Cross-platform sync and privacy**: sensitive data on every device, encrypted, possibly self-hosted.
