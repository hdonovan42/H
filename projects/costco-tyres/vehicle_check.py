#!/usr/bin/env python3
"""
UK Vehicle Check (Free Government APIs)

Looks up a vehicle by UK registration plate and returns:
  - DVLA data (tax, MOT expiry, colour, fuel, CO2, etc.)
  - Full MOT history with mileage readings
  - Mileage anomaly detection (clocking, gaps, spikes)
  - Outstanding advisories from last MOT
"""

import os
import sys
import requests
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, date

# Free government API keys — register at:
#   DVLA: developer-portal.driver-vehicle-licensing.api.gov.uk
#   MOT:  dvsa.github.io/mot-history-api-documentation
DVLA_API_KEY = os.environ.get("DVLA_API_KEY", "")
MOT_API_KEY = os.environ.get("MOT_API_KEY", "")


def dvla_lookup(plate: str) -> dict | None:
    """Query DVLA Vehicle Enquiry Service for vehicle details."""
    if not DVLA_API_KEY:
        return None
    url = "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles"
    headers = {"x-api-key": DVLA_API_KEY, "Content-Type": "application/json"}
    try:
        r = requests.post(url, json={"registrationNumber": plate}, headers=headers, timeout=15)
        if r.status_code == 200:
            return r.json()
    except Exception:
        pass
    return None


def mot_lookup(plate: str) -> dict | None:
    """Query DVSA MOT History API for full test history."""
    if not MOT_API_KEY:
        return None
    url = "https://beta.check-mot.service.gov.uk/trade/vehicles/mot-tests"
    headers = {"x-api-key": MOT_API_KEY, "Accept": "application/json+v6"}
    params = {"registration": plate}
    try:
        r = requests.get(url, params=params, headers=headers, timeout=15)
        if r.status_code == 200:
            data = r.json()
            if isinstance(data, list) and data:
                return data[0]
    except Exception:
        pass
    return None


def analyse_mileage(tests: list[dict]) -> dict:
    """Analyse MOT mileage readings for anomalies (clocking, gaps, spikes)."""
    readings = []
    for t in tests:
        odo = t.get("odometerValue")
        if not odo or odo == "0":
            continue
        try:
            date_str = t.get("completedDate", "").split(" ")[0]
            test_date = datetime.strptime(date_str, "%Y.%m.%d").date()
            miles = int(odo)
            unit = t.get("odometerUnit", "mi")
            if unit == "km":
                miles = int(miles * 0.621371)
            readings.append({"date": test_date, "miles": miles, "result": t.get("testResult", "?")})
        except (ValueError, IndexError):
            continue

    if not readings:
        return {"readings": [], "anomalies": [], "avg_annual": 0, "latest_miles": 0}

    readings.sort(key=lambda x: x["date"])

    anomalies = []
    for i in range(1, len(readings)):
        prev, curr = readings[i - 1], readings[i]
        diff_miles = curr["miles"] - prev["miles"]
        diff_days = (curr["date"] - prev["date"]).days
        if diff_days <= 0:
            continue

        annual_rate = diff_miles / diff_days * 365
        curr["diff"] = diff_miles
        curr["annual_rate"] = annual_rate

        if diff_miles < 0:
            anomalies.append({
                "type": "CLOCKING",
                "desc": f"Mileage DECREASED by {abs(diff_miles):,} mi between "
                        f"{prev['date']} and {curr['date']}",
            })
        elif annual_rate > 40000:
            anomalies.append({
                "type": "HIGH_MILEAGE",
                "desc": f"Implausibly high rate ({annual_rate:,.0f} mi/yr) between "
                        f"{prev['date']} and {curr['date']}",
            })

        if diff_days > 800:
            anomalies.append({
                "type": "GAP",
                "desc": f"{diff_days // 365}+ year gap between MOTs "
                        f"({prev['date']} to {curr['date']}) — possible off-road period",
            })

    total_miles = readings[-1]["miles"] - readings[0]["miles"]
    total_days = (readings[-1]["date"] - readings[0]["date"]).days
    avg_annual = total_miles / total_days * 365 if total_days > 0 else 0

    return {
        "readings": readings,
        "anomalies": anomalies,
        "avg_annual": avg_annual,
        "latest_miles": readings[-1]["miles"],
    }


def print_vehicle_report(dvla: dict | None, mot: dict | None):
    """Print the free vehicle report section."""
    if not dvla and not mot:
        if not DVLA_API_KEY and not MOT_API_KEY:
            print("\n  ── Vehicle Report ──────────────────────────")
            print("  Set DVLA_API_KEY and MOT_API_KEY env vars for free vehicle checks.")
            print("    DVLA: developer-portal.driver-vehicle-licensing.api.gov.uk")
            print("    MOT:  dvsa.github.io/mot-history-api-documentation")
        return

    print("\n  ── Vehicle Report ──────────────────────────")

    # DVLA section
    if dvla:
        print("\n  DVLA")

        # Tax status warning
        tax = dvla.get("taxStatus", "")
        tax_display = tax
        if tax == "SORN":
            tax_display = "SORN ⚠"
        elif tax and tax != "Taxed":
            tax_display = f"{tax} ⚠"

        # MOT expiry warning
        mot_expiry = dvla.get("motExpiryDate", "")
        mot_display = mot_expiry
        if mot_expiry:
            try:
                exp = datetime.strptime(mot_expiry, "%Y-%m-%d").date()
                days_left = (exp - date.today()).days
                if days_left < 0:
                    mot_display = f"{mot_expiry} — EXPIRED ⚠"
                elif days_left < 30:
                    mot_display = f"{mot_expiry} — expires in {days_left} days ⚠"
            except ValueError:
                pass

        fields = [
            ("Colour", dvla.get("colour", "—")),
            ("Fuel", dvla.get("fuelType", "—")),
            ("Tax status", tax_display),
            ("Tax due", dvla.get("taxDueDate", "—")),
            ("MOT expires", mot_display or "—"),
            ("CO₂", f"{dvla['co2Emissions']} g/km" if dvla.get("co2Emissions") else "—"),
            ("Euro status", dvla.get("euroStatus", "—")),
            ("First reg", dvla.get("monthOfFirstRegistration", "—")),
            ("Wheelplan", dvla.get("wheelplan", "—")),
            ("Rev. weight", f"{dvla['revenueWeight']:,} kg" if dvla.get("revenueWeight") else None),
        ]
        for label, value in fields:
            if value is not None:
                print(f"    {label + ':':<16}{value}")
    elif DVLA_API_KEY:
        print("\n  DVLA: No data returned")

    # MOT History section
    if mot:
        tests = mot.get("motTests", [])
        if tests:
            print(f"\n  MOT History ({len(tests)} tests)")
            analysis = analyse_mileage(tests)
            readings_by_date = {r["date"]: r for r in analysis["readings"]}

            for t in tests[:12]:
                date_str = t.get("completedDate", "?")
                try:
                    d = datetime.strptime(date_str.split(" ")[0], "%Y.%m.%d").date()
                    date_display = d.strftime("%Y-%m-%d")
                except (ValueError, IndexError):
                    date_display = date_str[:10]
                    d = None

                result = t.get("testResult", "?")
                result_icon = "✓" if result == "PASSED" else "✗"

                odo = t.get("odometerValue", "")
                odo_str = f"{int(odo):>8,} mi" if odo and odo != "0" else "         —"

                rate_str = ""
                if d and d in readings_by_date and "annual_rate" in readings_by_date[d]:
                    rate_str = f"  ({readings_by_date[d]['annual_rate']:,.0f}/yr)"

                rfr = t.get("rfrAndComments", [])
                advisories = [c for c in rfr if c.get("type") == "ADVISORY"]
                failures = [c for c in rfr if c.get("type") in ("FAIL", "MAJOR", "DANGEROUS")]

                suffix = ""
                if failures:
                    suffix += f"  ✗ {len(failures)} failure{'s' if len(failures) > 1 else ''}"
                if advisories:
                    suffix += f"  ⚠ {len(advisories)} advisor{'ies' if len(advisories) > 1 else 'y'}"

                print(f"    {date_display}  {result_icon} {result:<8}{odo_str}{rate_str}{suffix}")

            if len(tests) > 12:
                print(f"    ... and {len(tests) - 12} older tests")

            # Mileage analysis
            if analysis["readings"]:
                print(f"\n  Mileage Analysis")
                print(f"    Latest:     {analysis['latest_miles']:,} mi")
                print(f"    Average:    ~{analysis['avg_annual']:,.0f} mi/year")

                if analysis["anomalies"]:
                    for a in analysis["anomalies"]:
                        icon = "🚨" if a["type"] == "CLOCKING" else "⚠"
                        print(f"    {icon} {a['desc']}")
                else:
                    print(f"    ✓ No mileage anomalies detected")

            # Advisories from last MOT
            last_rfr = tests[0].get("rfrAndComments", [])
            advisories = [c for c in last_rfr if c.get("type") == "ADVISORY"]
            if advisories:
                print(f"\n  Outstanding Advisories (last MOT)")
                for a in advisories:
                    print(f"    • {a['text']}")
        else:
            print("\n  MOT History: No tests on record (new vehicle?)")
    elif MOT_API_KEY:
        print("\n  MOT History: No data returned")


def fetch_vehicle_report(plate: str) -> tuple[dict | None, dict | None]:
    """Fetch DVLA + MOT data in parallel. Returns (dvla, mot) tuple."""
    clean = plate.upper().replace(" ", "")
    dvla, mot = None, None
    if DVLA_API_KEY or MOT_API_KEY:
        with ThreadPoolExecutor(max_workers=2) as pool:
            dvla_f = pool.submit(dvla_lookup, clean) if DVLA_API_KEY else None
            mot_f = pool.submit(mot_lookup, clean) if MOT_API_KEY else None
            dvla = dvla_f.result() if dvla_f else None
            mot = mot_f.result() if mot_f else None
    return dvla, mot


def main():
    print("\n  ╔══════════════════════════════════════╗")
    print("  ║  UK Vehicle Check (Free Gov't APIs)  ║")
    print("  ╚══════════════════════════════════════╝")

    if not DVLA_API_KEY and not MOT_API_KEY:
        print("\n  No API keys set. Export these env vars:")
        print("    DVLA_API_KEY — developer-portal.driver-vehicle-licensing.api.gov.uk")
        print("    MOT_API_KEY  — dvsa.github.io/mot-history-api-documentation")
        print()
        sys.exit(1)

    while True:
        print()
        plate = input("  Enter registration plate: ").strip()
        if not plate:
            print("  No plate entered.")
            continue

        print(f"\n  Looking up {plate.upper()}...")
        dvla, mot = fetch_vehicle_report(plate)
        print_vehicle_report(dvla, mot)

        again = input("\n  Search another vehicle? [y/n]: ").strip().lower()
        if again != "y":
            print("  Bye!\n")
            break


if __name__ == "__main__":
    main()
