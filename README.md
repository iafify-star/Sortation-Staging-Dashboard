# Sortation & Staging Dashboard

Arabic (RTL) dashboard for noon minutes outbound sortation and staging: sorting batch, sortation cross dock, staging, and an hourly report with IPP per person.

Open `index.html` in a browser or host the folder on any static host (no build step). The site reads the **STAGE** Google Sheet's tabs as public CSV and refreshes every minute, so the sheet must be shared as "Anyone with the link — Viewer". People's names come from the NIM attendance sheet.

The sheet is filled every hour by a sync that runs in Chrome on Minutes Central and grocery-tools and posts to the sheet's Apps Script web app. Those scripts carry the web app token, so they are kept out of this repository.
