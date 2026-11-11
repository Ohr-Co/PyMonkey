# Scrape: print every link on the page.
for link in page.select("a[href]"):
    print(link.get_text(strip=True) or "(no text)", "->", link["href"])
