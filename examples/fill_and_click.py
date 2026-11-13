# Automate: type into a search box, submit, then read the new page state.
# Adjust the selectors for the site you are on.
page.fill("input[type=search], input[name=q]", "pyodide")
page.click("button[type=submit]")
page.wait_for(".results", timeout=10)
page.refresh()  # re-snapshot so page.soup reflects the updated page
for item in page.select(".results a")[:5]:
    print(item.get_text(strip=True))
