# Fullshot

A Chrome extension that captures a full page screenshot in one click, including everything below the fold, no scrolling and stitching required.

> **Live on the Chrome Web Store.** [Install Fullshot](https://chromewebstore.google.com/detail/fullshot-full-page-screen/gdejgnbdmnfpdalaaefhmbecnecdfkbf) in one click, or see [Installation](#installation) below to run it unpacked from source.

## Why

Most "full page screenshot" tools scroll the page in segments and stitch the images together client-side. That approach is slow, visibly janky, and breaks in predictable ways: sticky headers repeat in every segment, and lazy-loaded images below the fold often never render because the tool never actually paused there long enough.

Fullshot avoids this differently. It uses the Chrome DevTools Protocol to measure the page's true full content height, then actually resizes the page's rendered viewport to match that height using `Emulation.setDeviceMetricsOverride`, and takes one completely normal screenshot once the layout has settled, at 2x resolution rather than the browser's default 1x, so captures stay sharp when you zoom in on small text. Before that, it does one quick scroll-through pass to trigger any lazy-loaded content, then returns to the top so sticky elements render in their natural state.

This matters more than it sounds like it should. Chrome also offers a `captureBeyondViewport` mode that claims to capture past the visible viewport in a single call without resizing anything, but on real-world pages with sticky headers or `vh`-based layout sections, it can duplicate paint tiles and produce a screenshot with the same content repeated several times. Actually resizing the viewport and capturing normally sidesteps that bug entirely, since there's no internal tiling involved at all.

## How it works

1. Click the extension icon on any page.
2. It scrolls through the page once (fast, in the background) to trigger lazy-loaded images, then returns to the top.
3. It attaches the Chrome DevTools Protocol, measures the full page height, and resizes the page's actual viewport to match it.
4. Once the layout settles, it takes one normal screenshot at that size, at 2x resolution, then restores the original viewport.
5. The PNG downloads automatically into a `fullshot/` folder in your Downloads, named after the site and timestamp.

No visible scrolling, no stitching artifacts, no repeated headers, for pages that fit in one capture (see below for what happens when a page doesn't).

### Very tall pages: split instead of blurry or cut off

A screenshot at real resolution takes up a lot more pixels than the same page at the browser's default scale, so very tall pages (long tables, long articles, endless feeds) can exceed what a single capture can safely hold. Earlier versions handled this by silently cropping anything past a fixed height, you'd get a shorter screenshot with no indication the bottom of the page was missing.

v1.1 instead splits a page that doesn't fit into multiple full-resolution files (`page_part1-of-3.png`, `page_part2-of-3.png`, etc.), so you get everything at full quality across a few files instead of one incomplete or blurry one. The one tradeoff: a page split into parts is captured by scrolling between each part, so a sticky or fixed header will appear again at the top of every part after the first, unlike the single-shot path, which only ever renders it once. For most pages (a few thousand pixels tall) this never comes up, everything still fits in a single capture.

## Permissions used

- `debugger`, required to use the Chrome DevTools Protocol for full-page capture
- `activeTab`, only accesses the tab you click the icon on, not your whole browsing history
- `scripting`, runs the pre-scroll pass to trigger lazy-loaded content
- `downloads`, saves the resulting PNG
- `notifications`, confirms when a screenshot is saved, or reports an error

## Installation

The easiest way is the [Chrome Web Store listing](https://chromewebstore.google.com/detail/fullshot-full-page-screen/gdejgnbdmnfpdalaaefhmbecnecdfkbf).

To run it unpacked from source instead:

1. Clone this repo.
2. Go to `chrome://extensions`, enable Developer mode.
3. Click "Load unpacked" and select this folder.
4. Click the extension icon on any page to capture it.

## Known limitations

- Pages with genuinely infinite scroll are capped at 12 parts to avoid pathological captures.
- On a page that needs splitting, a sticky or fixed header will repeat at the top of every part after the first (see above).
- Won't work on `chrome://` pages, the Chrome Web Store, or other browser-internal pages, Chrome blocks the debugger API there for all extensions.
- Using the debugger API shows a brief "extension started debugging this browser" notice in the tab, this is standard Chrome behavior for any extension using DevTools Protocol, not a bug.

Built by [Soumik Chatterjee](https://cosmik.work).
