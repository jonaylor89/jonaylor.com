"""Read Instagram's English HTML export locally, without loading remote assets."""

from __future__ import annotations

import datetime as dt
from html.parser import HTMLParser
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement


class _Parser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Element("document")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = SubElement(self.stack[-1], tag, dict(attrs))
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        node = self.stack[-1]
        if len(node):
            node[-1].tail = (node[-1].tail or "") + data
        else:
            node.text = (node.text or "") + data


def _read(path: Path) -> Element:
    parser = _Parser()
    parser.feed(path.read_text(encoding="utf-8"))
    return parser.root


def _text(node: Element) -> str:
    # Preserve line breaks and block boundaries, without flattening words together.
    parts = [node.text or ""]
    for child in node:
        if child.tag not in {"ul", "script", "style"}:  # reactions aren't message text
            block = child.tag in {"div", "br", "p", "li"}
            parts.extend(["\n" if block else "", _text(child), "\n" if block else ""])
        parts.append(child.tail or "")
    return "".join(parts)


def _class(node: Element, name: str) -> bool:
    return name in node.get("class", "").split()


def own_name(path: Path) -> str | None:
    for cell in _read(path).iter("td"):
        if (cell.text or "").strip() == "Name":
            return "".join(cell.itertext())[len(cell.text or ""):].strip() or None
    return None


def thread(path: Path, me: str) -> tuple[list[dict], list[dict]]:
    root = _read(path)
    title = next((_text(n).strip() for n in root.iter("h1")), "")
    messages = []
    names = {me}
    for card in root.iter("div"):
        if not _class(card, "_a6-g"):
            continue
        sender = next((_text(n).strip() for n in card.iter("h2")), None)
        body = next((n for n in card if _class(n, "_a6-p")), None)
        date = next((n for n in card if _class(n, "_a6-o")), None)
        if sender and date is None and sender.startswith(("Participants:", "Group Invite Link:")):
            # Group metadata cards are not messages. The title keeps even a
            # group with only one observed sender out of the one-to-one set.
            if title:
                names.add(title)
            continue
        if not sender or body is None or date is None:
            raise ValueError(f"Unrecognized Instagram message card in {path}")
        # HTML dates have UTC minute precision; JSON retains milliseconds.
        when = dt.datetime.strptime(_text(date).strip(), "%b %d, %Y %I:%M %p").replace(tzinfo=dt.timezone.utc)
        text = "\n".join(line.strip() for line in _text(body).splitlines() if line.strip())
        messages.append({"sender_name": sender, "timestamp_ms": int(when.timestamp() * 1000), "content": text})
        names.add(sender)
    # A group title is not a participant. Don't promote a group with just one
    # observed correspondent to a one-to-one relationship.
    if title and title not in names:
        names.add(title)
    return [{"name": name} for name in sorted(names)], messages
