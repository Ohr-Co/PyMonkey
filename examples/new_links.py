# Remember: print the links that were not on this page the last time the script ran.
# Save the script first: `page.store` keeps values per saved script.
seen = page.store.get("seen", [])
links = [link["href"] for link in page.select("a[href]")]

for href in links:
    if href not in seen:
        print("new:", href)

page.store.set("seen", sorted(set(seen) | set(links)))
