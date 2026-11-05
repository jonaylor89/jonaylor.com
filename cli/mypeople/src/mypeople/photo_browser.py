"""Opt-in Playwright sessions, isolated from the user's everyday browser."""

from __future__ import annotations

import os
from contextlib import ExitStack
from pathlib import Path

from .profile_urls import host_for, profile_url, site
from .social_photos import SOURCES, image_allowed, instagram_image


class BrowserError(RuntimeError):
    pass


class PhotoBrowser:
    def __init__(self, root: Path | None = None):
        self.root = root or Path.home() / ".mypeople" / "photo-browser"
        self.stack = ExitStack()
        self.contexts = {}
        self.dm_page = None

    def __enter__(self):
        try:
            from playwright.sync_api import sync_playwright, Error
        except ImportError:
            raise BrowserError("Run: uv sync --extra browser && uv run --extra browser playwright install chromium") from None
        self.error = Error
        self.playwright = self.stack.enter_context(sync_playwright())
        return self

    def __exit__(self, *args):
        self.stack.close()

    def context(self, source):
        if source not in SOURCES:
            raise BrowserError("Only LinkedIn and Instagram sessions are supported")
        if source not in self.contexts:
            folder = self.root / source
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(self.root, 0o700)
            os.chmod(folder, 0o700)
            try:
                context = self.playwright.chromium.launch_persistent_context(
                    str(folder), headless=False, accept_downloads=False,
                    permissions=[], viewport={"width": 1280, "height": 900})
            except self.error:
                raise BrowserError("Could not open the photo browser. Install Chromium with `uv run --extra browser playwright install chromium`; close other MyPeople photo browsers.") from None
            self.stack.callback(self._close, context)
            self.contexts[source] = context
        return self.contexts[source]

    def _close(self, context):
        try:
            context.close()
        except self.error:
            pass  # The user may have already closed the dedicated window.

    def login(self, source, prompt=input):
        page = self.context(source).new_page()
        try:
            # Instagram can reject its login document route while the home
            # document correctly presents sign-in (or the existing session).
            page.goto({"instagram": "https://www.instagram.com/",
                       "linkedin": "https://www.linkedin.com/login"}[source], wait_until="domcontentloaded", timeout=45000)
            prompt(f"Log into {source} in the dedicated browser (including any 2FA), then press Enter here. ")
        except self.error:
            raise BrowserError("Browser closed or login navigation failed; run --login again.") from None
        finally:
            if not page.is_closed():
                page.close()

    def instagram_thread(self, thread):
        """(username, display name, detail) of a 1:1 DM thread's partner, from its header only.

        The header link is the only one near the top of the page whose text is a display
        name over the username it links to; shared profiles and posts lie further down.
        """
        if not thread.isdigit():
            return None, None, "not an Instagram thread id"
        url = f"https://www.instagram.com/direct/t/{thread}/"
        try:
            if self.dm_page is None:
                # Bootstrap the web app once, as image() does; then reuse one tab.
                self.dm_page = self.context("instagram").new_page()
                self.dm_page.goto("https://www.instagram.com/", wait_until="domcontentloaded", timeout=45000)
            page = self.dm_page
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            if host_for(page.url) != "instagram.com" or "/accounts/login" in page.url:
                raise BrowserError("The Instagram session is signed out; run `mypeople photos --source instagram --login`.")
            found = page.wait_for_function("""() => {
                for (const a of document.querySelectorAll('a[href]')) {
                    const handle = (a.getAttribute('href') || '').replace(/^\\/|\\/$/g, '');
                    const lines = (a.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
                    if (a.getBoundingClientRect().top < 120 && lines.length === 2 && lines[1] === handle)
                        return [handle, lines[0]];
                }
                return null;
            }""", polling=500, timeout=20000).json_value()  # rAF polling stalls in a hidden window
        except self.error:
            return None, None, "no thread header (deleted account, unavailable thread, or slow page)"
        if page.url != url:
            return None, None, "Instagram opened a different page"
        return found[0], found[1], "thread header"

    def image(self, url):
        source = site(url)
        page = self.context(source).new_page()
        try:
            browser_url = url.replace(f"https://{source}.com/", f"https://www.{source}.com/") + "/"
            if source == "instagram":
                # Profile/login document routes can fail while the signed-in home
                # and same-origin API still work. Bootstrap the web app first.
                page.goto("https://www.instagram.com/", wait_until="domcontentloaded", timeout=45000)
                if host_for(page.url) != "instagram.com":
                    return None, "browser left Instagram; run --login"
                # Same-origin fetch in this explicitly authorized session. Retain
                # only the requested username and avatar; never export cookies.
                handle = url.rsplit("/", 1)[-1]
                data = page.evaluate("""async handle => {
                    try {
                        const r = await fetch('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(handle),
                            {headers: {'X-IG-App-ID': '936619743392459'}, signal: AbortSignal.timeout(15000)});
                        if (!r.ok) return {};
                        const u = (await r.json())?.data?.user;
                        return {data: {user: {username: u?.username, profile_pic_url_hd: u?.profile_pic_url_hd,
                            profile_pic_url: u?.profile_pic_url, has_anonymous_profile_picture: u?.has_anonymous_profile_picture}}};
                    } catch { return {}; }
                }""", handle)
                image = instagram_image(data, handle)
                if image and image_allowed(image, source):
                    return image, "dedicated browser API"
                selector = 'header img'
            else:
                # New LinkedIn layouts use generated CSS classes; semantic view
                # names identify the actual top-card avatar, not the nav user's
                # avatar, feed authors, company logos, or cover image.
                selector = ('[data-view-name="profile-top-card-member-photo"] img, '
                            '[componentkey="topcard-logo-image-referencekey"] img, '
                            'img.pv-top-card-profile-picture__image, img.pv-top-card-profile-picture__image--show, '
                            'img.profile-photo-edit__preview, img.top-card-layout__entity-image')
            page.goto(browser_url, wait_until="domcontentloaded", timeout=45000)
            if profile_url(page.url) != url:
                return None, "browser redirected to login/challenge or a different account; run --login"
            page.locator(selector).first.wait_for(state="visible", timeout=10000)
            # Recheck after client-side routing. Never use feed/post thumbnails.
            if profile_url(page.url) != url:
                return None, "browser left the requested profile"
            for image in page.locator(selector).evaluate_all("els => els.map(e => e.currentSrc || e.src)"):
                if image_allowed(image, source):
                    return image, "dedicated browser profile"
            return None, "no supported profile image in browser"
        except self.error:
            return None, "browser blocked, timed out, or needs login; run --login"
        finally:
            if not page.is_closed():
                page.close()
