#!/usr/bin/env python3
"""Builds the map's bundled country outlines from Natural Earth (public domain).

    curl -fLO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
    python3 -I scripts/build-geodata.py ne_50m_admin_0_countries.geojson App/Geo

Writes countries.json: simplified outlines and a label point for each country. The
IP-to-country table isn't bundled: the app downloads and converts it (GeoIPTable.swift).
"""

import json
import sys
from pathlib import Path

# Territories IP tables report that have no outline of their own at this scale.
EXTRA_LABELS = {
    "BQ": ("Caribbean Netherlands", -68.26, 12.18), "BV": ("Bouvet Island", 3.4, -54.4),
    "CC": ("Cocos Islands", 96.87, -12.16), "CX": ("Christmas Island", 105.69, -10.45),
    "GF": ("French Guiana", -53.1, 3.9), "GI": ("Gibraltar", -5.35, 36.14),
    "GP": ("Guadeloupe", -61.55, 16.25), "MQ": ("Martinique", -61.0, 14.65),
    "RE": ("Réunion", 55.5, -21.1), "SJ": ("Svalbard", 15.6, 78.2),
    "TK": ("Tokelau", -171.8, -9.2), "UM": ("U.S. Outlying Islands", 166.6, 19.3),
    "YT": ("Mayotte", 45.15, -12.8),
}
PRECISION = 0.2  # degrees; plenty for a map a few hundred points wide


def simplify(ring: list[list[float]]) -> list[float]:
    flat: list[float] = []
    last = None
    for lon, lat in ring:
        point = (round(lon / PRECISION) * PRECISION, round(lat / PRECISION) * PRECISION)
        if point != last:
            flat += [round(point[0], 1), round(point[1], 1)]
            last = point
    return flat if len(flat) >= 8 else []


def build_countries(source: Path) -> list[dict]:
    countries = []
    for feature in json.loads(source.read_text())["features"]:
        props = feature["properties"]
        code = props["ISO_A2_EH"]
        geometry = feature["geometry"]
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        rings = [r for polygon in polygons if (r := simplify(polygon[0]))]  # outer rings only
        countries.append({
            "c": code if code != "-99" else "",
            "n": props["NAME"],
            "l": [round(props["LABEL_X"], 2), round(props["LABEL_Y"], 2)],
            "p": rings,
        })
    known = {c["c"] for c in countries}
    for code, (name, lon, lat) in EXTRA_LABELS.items():
        if code not in known:
            countries.append({"c": code, "n": name, "l": [lon, lat], "p": []})
    return countries


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    shapes, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    countries = build_countries(shapes)
    (out_dir / "countries.json").write_text(json.dumps(countries, separators=(",", ":"), ensure_ascii=False))
    print(f"{out_dir}/countries.json ({len(countries)} countries)")


if __name__ == "__main__":
    main()
