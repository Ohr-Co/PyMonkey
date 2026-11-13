# Export: save every link on the page as links.csv in your Downloads folder,
# ready to open in a spreadsheet.
rows = [
    {"text": link.get_text(strip=True), "href": link["href"]}
    for link in page.select("a[href]")
]
page.download("links.csv", rows)
print("Saved", len(rows), "links to links.csv")
