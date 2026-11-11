# Scrape across pages: fetch the first few links on this page and print each one's title.
from urllib.parse import urljoin

for link in page.select("a[href]")[:5]:
    address = urljoin(page.url, link["href"])
    if not address.startswith("http"):
        continue  # mailto:, javascript: and the like
    try:
        response = page.fetch(address, timeout=10)
        response.raise_for_status()
    except OSError as error:  # no answer, too slow, or an error status
        print("skipped", address, "-", error)
        continue
    title = response.soup.select_one("title")
    print(title.get_text(strip=True) if title else "(no title)", "->", response.url)
