# Edit the page: highlight every heading and add a banner with the count.
headings = page.select("h1, h2, h3")
page.set_style("h1, h2, h3", "background: #fff3a3; color: #000")
page.insert_html(
    "body",
    f"<div style='position:fixed;bottom:12px;right:12px;padding:8px 12px;"
    f"background:#222;color:#fff;border-radius:8px;z-index:99999'>"
    f"PyMonkey found {len(headings)} headings</div>",
)
print(f"Highlighted {len(headings)} headings")
