# ==PyMonkey==
# @name     Price memory
# @match    https://www.amazon.com/*
# @timeout  120
# ==/PyMonkey==

# Remembers a product's price each time you open its page and shows how it
# has moved. The first time it sees a product, it fills in the past 3 months
# from the Wayback Machine's snapshots of the page, if there are any.
#
# The Wayback Machine does not let other sites read it, so allow PyMonkey on
# web.archive.org once: the panel offers to when the first lookup fails.

import re
from datetime import date, timedelta

# Where the price is. The first selector that matches wins, so the more
# specific ones come first: Amazon pages also list the prices of other products.
PRICES = [
    "#corePrice_feature_div .a-offscreen",               # Amazon
    "#corePriceDisplay_desktop_feature_div .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    "[itemprop=price]",                                  # most other shops
    ".price",
]
# Where to put the badge: under the first of these that the page has.
BADGE_AFTER = ["#corePriceDisplay_desktop_feature_div", "#corePrice_feature_div", "#apex_desktop", "[itemprop=price]", ".price"]
SNAPSHOTS = 10                        # how many old copies to read, at most


def read_price(soup):
    el = next((e for sel in PRICES if (e := soup.select_one(sel))), None)
    if el is None:
        return None
    digits = re.sub(r"[^\d.]", "", el.get("content") or el.get_text())
    try:
        return float(digits)
    except ValueError:
        return None


def past_prices(url, days=90):
    """Prices from Wayback Machine snapshots of `url` in the last `days` days, oldest first."""
    since = (date.today() - timedelta(days=days)).strftime("%Y%m%d")
    rows = page.fetch("https://web.archive.org/cdx/search/cdx", params={
        "url": url, "from": since, "output": "json", "fl": "timestamp",
        "filter": "statuscode:200", "collapse": "timestamp:8",   # one per day
    }).json()[1:]                                                # row 0 is the header
    if len(rows) > SNAPSHOTS:                                    # spread them over the period
        step = len(rows) / SNAPSHOTS
        rows = [rows[int(i * step)] for i in range(SNAPSHOTS)]

    found = []
    for (ts,) in rows:
        # "id_" asks for the page as it was archived, without the Wayback toolbar
        snapshot = page.fetch(f"https://web.archive.org/web/{ts}id_/{url}")
        price = snapshot.ok and read_price(snapshot.soup)
        if price:
            found.append({"price": price, "seen": f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}", "archived": True})
    return found


def product_url(url):
    """One address per product. Amazon has many for each: /dp/<ASIN> is the one that stays."""
    asin = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", url)
    if asin:
        return f"{url.split('/')[0]}//{url.split('/')[2]}/dp/{asin.group(1)}"
    return url.split("?")[0]


price = read_price(page.soup)
if not price:
    print("No price found on this page. Check the selectors in PRICES.")
else:
    key = product_url(page.url)
    history = page.store.get(key, [])

    if not history:
        try:
            history = past_prices(key)
        except OSError as e:
            print("Could not read the Wayback Machine:", e)
        print(f"Found {len(history)} archived prices for this product")

    if not history or history[-1]["price"] != price:
        history.append({"price": price, "seen": date.today().isoformat()})
    # keep only the changes: drop a price that repeats the one before it
    history = [h for i, h in enumerate(history) if i == 0 or h["price"] != history[i - 1]["price"]]
    page.store.set(key, history)

    first, low = history[0], min(h["price"] for h in history)
    change = (price - first["price"]) / first["price"] * 100
    arrow = "↓" if change < 0 else "↑" if change > 0 else "="
    source = "archived" if first.get("archived") else "first seen"
    page.insert_html(next(s for s in BADGE_AFTER if page.select_one(s)), f"""
      <div style="font:13px system-ui;padding:6px 10px;margin-top:6px;border-radius:6px;
                  background:{'#e6f4ea' if price <= low else '#fdecea'}">
        {arrow} {abs(change):.0f}% since {first['seen']} ({source}) ·
        lowest: ${low:.2f} · {len(history) - 1} price changes
      </div>""", position="afterend")
    print(f"Now ${price:.2f}, lowest ${low:.2f}, {len(history)} prices known")
