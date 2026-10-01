#meta

PaperCutter: a workspace-wide **header picker**. Where the
[[View#Built-in views|Table of Contents]] outlines the page you are on, this
view lists the markdown headers of *every* page in the space (like
[zk](https://github.com/zk-org/zk)'s LSP): type to fuzzy-match a header or
the page it lives on, pick one, and jump straight to it.

* `Navigate: Header Picker`, bound to `Ctrl-Alt-h` (the `Ctrl-Alt-*` picker
  family: tags, mentions, links, commands).
* Rows are ordered the way the page picker orders pages: the current page's
  headers first, then pages by when they were last opened, then by last
  modified; headers stay in document order within a page.
* Headers of [[Meta Page|meta pages]] and pages hidden from navigation are
  left out -- they are not navigation targets.
* Like any [[View]] it can be docked: use its dock menu to move it to a
  sidebar, the bottom panel, or a page dock, and that choice sticks from
  then on.

## Implementation

```space-lua
-- PaperCutter: a workspace-wide header picker as a Space Lua view. The
-- pieces mirror what the page picker does for pages: filter meta and
-- hidden pages out, order by page recency, and navigate to the exact
-- position -- `pos` is precise even for duplicate header names.

local function isMetaPage(page)
  for _, tag in ipairs(page.tags or {}) do
    if tag == "template" or tag == "meta" or string.startsWith(tag, "meta/") then
      return true
    end
  end
  return false
end

local function isHiddenPage(page)
  return page.pageDecoration and page.pageDecoration.hide == true
end

-- Rows in recency order: the current page's headers first, then pages by
-- when they were last opened, then by last modified; document order within
-- a page. The panel's fuzzy ranking works over this order, so it survives
-- as the tiebreaker for equal matches.
local function headerRows()
  local currentPage = editor.getCurrentPage()
  local opened = editor.getLastOpenedMap() or {}
  local pageState = {}
  for _, page in ipairs(query[[ from p = index.pages() ]]) do
    if not isMetaPage(page) and not isHiddenPage(page) then
      pageState[page.name] = {
        lastOpened = opened[page.name] or 0,
        lastModified = page.lastModified or "",
      }
    end
  end

  local rows = {}
  for _, header in ipairs(query[[ from h = index.headers() ]]) do
    if pageState[header.page] then
      table.insert(rows, {
        name = header.name,
        page = header.page,
        pos = header.pos,
      })
    end
  end

  local function before(a, b)
    if a.page == b.page then
      return (a.pos or 0) < (b.pos or 0)
    end
    local aCurrent, bCurrent = a.page == currentPage, b.page == currentPage
    if aCurrent ~= bCurrent then
      return aCurrent
    end
    local pa, pb = pageState[a.page], pageState[b.page]
    if pa.lastOpened ~= pb.lastOpened then
      return pa.lastOpened > pb.lastOpened
    end
    if pa.lastModified ~= pb.lastModified then
      return pa.lastModified > pb.lastModified
    end
    return a.page < b.page
  end
  table.sort(rows, before)
  return rows
end

view.define {
  name = "std.headers",
  title = "Headers",
  label = "Open",
  placeholder = "Header",
  command = "Navigate: Header Picker",
  -- Ctrl-Shift-h is taken by "Navigate: Home"; Ctrl-Alt-h matches the
  -- Ctrl-Alt-* picker family (tags, mentions, links, commands).
  key = "Ctrl-Alt-h",
  menu = { location = "navigate", group = "2_picker", order = 5, label = "Header..." },
  dock = "modal",
  supportedDocks = { "modal", "lhs", "rhs", "bhs", "page-top", "page-bottom" },
  refreshOn = { "file:changed", "file:deleted", "mq:emptyQueue:indexQueue" },
  refreshOnOpen = true,
  -- Ranked against the header's name, but the host page stays matchable --
  -- "intro proj" finds `#Intro` on Projects/Alpha.
  filter = {
    fields = {
      primary = { weight = 1, segments = true },
      page = { weight = 0.6, segments = true },
      description = 0.4,
    },
  },
  presentation = {
    mode = "list",
    row = {
      primary = "name",
      description = function(obj)
        return "in " .. obj.page
      end,
      icon = "hash",
    },
  },
  onSelect = function(obj)
    editor.navigate {
      path = obj.page .. ".md",
      details = { type = "position", pos = obj.pos },
    }
  end,
  source = headerRows,
}
```
