#!/usr/bin/env python3
"""
Costco UK Michelin Tyre Stock Checker

Looks up a vehicle by registration plate, finds all Michelin tyres
available at Costco UK with prices and stock levels.
"""

import re
import sys
import requests
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "https://www.costco.co.uk/rest/v2/uk"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}


def lookup_reg(plate: str) -> dict:
    """Look up vehicle + tyre sizes from registration plate."""
    url = f"{BASE}/tires/registrationsearch"
    params = {"regNo": plate.upper().replace(" ", ""), "stateCode": "uk", "fields": "FULL"}
    r = requests.get(url, params=params, headers=HEADERS, timeout=15)
    r.raise_for_status()
    body = r.json()

    if body.get("responseCode") != "200" or body.get("responseMessage") != "valid":
        print(f"\nCouldn't find vehicle for plate: {plate}")
        print(f"Response: {body.get('responseMessage', 'unknown error')}")
        sys.exit(1)

    return body["data"]


def search_michelin(width: str, profile: str, rim: str) -> list[dict]:
    """Search for Michelin tyres matching a given size. Returns product stubs."""
    query = f":relevance:tireWidth:{width}:tireProfile:{profile}:tireRimSize:{rim}:brand:Michelin"
    url = f"{BASE}/products/search"
    params = {"query": query, "pageSize": 100, "currentPage": 0, "fields": "FULL"}
    r = requests.get(url, params=params, headers=HEADERS, timeout=15)
    r.raise_for_status()
    body = r.json()
    return body.get("products", [])


def get_product_detail(code: str) -> dict | None:
    """Fetch full product detail including price and stock."""
    url = f"{BASE}/products/{code}"
    params = {"fields": "FULL"}
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
        return r.json()
    except Exception:
        return None


def normalise_model_name(full_name: str) -> tuple[str, list[str]]:
    """
    Extract the Michelin model name and variant tags from the full product name.

    e.g. "Michelin 225/45 ZR17 (94Y) XL TL PILOT SPORT 5"
      -> ("Pilot Sport 5", ["XL"])
    """
    name = full_name.upper()

    # Remove "MICHELIN" prefix
    name = re.sub(r"^MICHELIN\s*", "", name)

    # Remove size block: "225/45 ZR17", "225/45R17", "225/45 R17"
    name = re.sub(r"\d{3}/\d{2}\s*Z?R\s*\d{2,3}", "", name)

    # Remove all load/speed patterns (varied formats from Costco):
    #   (94Y)  |  94V  |  (94) Y  |  92 (Y)  |  (92Y)
    name = re.sub(r"\(\d{2,3}\)\s*[A-Z]", "", name)       # (94) Y
    name = re.sub(r"\d{2,3}\s*\([A-Z]+\)", "", name)      # 92 (Y)
    name = re.sub(r"\(\d{2,3}[A-Z]+\)", "", name)         # (94Y)
    name = re.sub(r"\b\d{2,3}\s*[A-Z]\b", "", name)       # 94V

    # Split joined tags: "XLTL" -> "XL TL"
    name = re.sub(r"\bXLTL\b", "XL TL", name)

    # Extract variant/OE tags before cleaning
    variants = []
    oe_tags = ["XL", "TL", "BSW", "FSL", "SELFSEAL", "ACOUSTIC", "EV",
               "MO", "MO1", "AO", "N0", "N1", "N2", "N3", "N4",
               "HN", "MI", "S1", "S2", "CONNECT", "PORSCHE"]
    for tag in oe_tags:
        pattern = rf"\b{re.escape(tag)}\b"
        if re.search(pattern, name):
            if tag not in ("TL", "BSW", "MI", "HN", "S1", "S2",
                           "PORSCHE", "N0", "N1", "N2", "N3", "N4", "CONNECT"):
                variants.append(tag)
            name = re.sub(pattern, "", name)

    # Remove BMW star marking
    if "*" in name:
        name = name.replace("*", "")

    # Clean up empty parens, extra spaces
    name = re.sub(r"\(\s*\)", "", name)
    name = re.sub(r"\s+", " ", name).strip()

    # Title case
    name = name.title()

    return name, variants


def deduplicate(products: list[dict]) -> list[dict]:
    """
    Group products by base model name. Within each group, keep distinct
    generations but merge XL/non-XL variants of the same model.
    """
    groups = defaultdict(list)

    for p in products:
        base_name, variants = normalise_model_name(p["name"])
        groups[base_name].append({**p, "_base": base_name, "_variants": variants})

    results = []
    for base_name, items in sorted(groups.items()):
        # Collect all unique variant tags across the group
        all_variants = set()
        for item in items:
            all_variants.update(item["_variants"])

        # Pick the cheapest item as representative
        priced = [i for i in items if i.get("price")]
        if priced:
            rep = min(priced, key=lambda x: x["price"].get("value", 999))
        else:
            rep = items[0]

        # Stock: take the max stock across variants
        stock_levels = [i.get("stock", {}).get("stockLevel", 0) for i in items]
        max_stock = max(stock_levels) if stock_levels else 0
        stock_status = "In Stock" if max_stock > 0 else "Out of Stock"

        variant_str = ", ".join(sorted(all_variants)) if all_variants else "Standard"

        results.append({
            "model": base_name,
            "price": rep.get("price", {}).get("formattedValue", "N/A"),
            "price_val": rep.get("price", {}).get("value", 999),
            "stock": max_stock,
            "stock_status": stock_status,
            "variants": variant_str,
            "count": len(items),
        })

    return sorted(results, key=lambda x: x["price_val"])


def print_table(rows: list[dict], vehicle: dict, size_str: str):
    """Print results as a formatted table."""
    if not rows:
        print("\n  No Michelin tyres found for this size.")
        return

    # Column widths
    model_w = max(len(r["model"]) for r in rows)
    model_w = max(model_w, 5)
    price_w = max(len(r["price"]) for r in rows)
    price_w = max(price_w, 5)
    var_w = max(len(r["variants"]) for r in rows)
    var_w = max(var_w, 8)

    header = f"  {'Model':<{model_w}}  {'Price':>{price_w}}  {'Stock':>5}  {'Variants':<{var_w}}"
    sep = f"  {'─' * model_w}  {'─' * price_w}  {'─' * 5}  {'─' * var_w}"

    print(f"\n  Michelin tyres available at Costco UK for {size_str}:\n")
    print(header)
    print(sep)

    for r in rows:
        stock_str = str(r["stock"]) if r["stock"] > 0 else "  ✗"
        print(f"  {r['model']:<{model_w}}  {r['price']:>{price_w}}  {stock_str:>5}  {r['variants']:<{var_w}}")

    print(sep)
    print(f"\n  {len(rows)} distinct models found ({sum(r['count'] for r in rows)} product listings)")
    print(f"  Available for fitting at all 29 Costco UK tyre centres.\n")


def run_search():
    """Run a single registration plate search."""
    plate = input("  Enter registration plate: ").strip()
    if not plate:
        print("  No plate entered.")
        return

    # 1. Look up vehicle
    print(f"\n  Looking up {plate.upper()}...")
    data = lookup_reg(plate)

    make = data.get("make", "Unknown")
    model = data.get("model", "Unknown")
    version = data.get("version", "")
    year = data.get("year", "")
    engine = data.get("engineSize", "")

    print(f"  Vehicle: {year} {make} {model} {version}".rstrip())
    if engine:
        print(f"  Engine: {engine}L")

    # 2. Show tyre size options
    sizes = data.get("tireSize", [])
    if not sizes:
        print("\n  No tyre sizes found for this vehicle.")
        return

    flat_sizes = []
    for group in sizes:
        for t in group.get("tyre", []):
            flat_sizes.append(t)

    print(f"\n  Tyre sizes for this vehicle:")
    for i, t in enumerate(flat_sizes, 1):
        w, p, r = t["width"], t["profile"], t["rimSize"]
        speed = t.get("speedRating", "?")
        load = t.get("loadIndex", "?")
        count = t.get("tireCount", 0) + t.get("higherSpeedRatingTireCount", 0)
        print(f"    [{i}] {w}/{p} R{r} {load}{speed}  ({count} tyres available)")

    # 3. Let user pick size(s)
    if len(flat_sizes) == 1:
        selected = [flat_sizes[0]]
        print(f"\n  Auto-selected only size.")
    else:
        choice = input(f"\n  Select size [1-{len(flat_sizes)}, or 'all']: ").strip().lower()
        if choice == "all":
            selected = flat_sizes
        else:
            try:
                idx = int(choice) - 1
                selected = [flat_sizes[idx]]
            except (ValueError, IndexError):
                print("  Invalid choice.")
                return

    # 4. Search for Michelin tyres
    for size in selected:
        w, p, r = size["width"], size["profile"], size["rimSize"]
        speed = size.get("speedRating", "?")
        load = size.get("loadIndex", "?")
        size_str = f"{w}/{p} R{r} {load}{speed}"

        print(f"\n  Searching Michelin tyres for {size_str}...")

        stubs = search_michelin(w, p, r)
        if not stubs:
            print(f"  No Michelin tyres found for {size_str}.")
            continue

        codes = [s["code"] for s in stubs if s.get("code")]
        print(f"  Found {len(codes)} Michelin listings, fetching details...")

        # Fetch product details in parallel
        products = []
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = {pool.submit(get_product_detail, code): code for code in codes}
            for future in as_completed(futures):
                result = future.result()
                if result:
                    products.append(result)

        # 5. Deduplicate and display
        rows = deduplicate(products)
        print_table(rows, data, size_str)


def main():
    print("\n  ╔══════════════════════════════════════════╗")
    print("  ║  Costco UK — Michelin Tyre Stock Checker ║")
    print("  ╚══════════════════════════════════════════╝")

    while True:
        print()
        run_search()
        again = input("\n  Search another vehicle? [y/n]: ").strip().lower()
        if again != "y":
            print("  Bye!\n")
            break


if __name__ == "__main__":
    main()
