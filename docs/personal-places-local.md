# Personal places / restaurants / travel: private source-owned shortlist

Purpose: personal day trips, restaurants, cafes, and sightseeing. This is original ARGUS code, NOT an imported Google Maps scraper.
Google Maps Scraper source reference: https://github.com/gosom/google-maps-scraper pinned 903b96d7aa8863188022c04db220e44f3218c860, MIT source only; that licence does NOT authorize automatic Google Maps content extraction.
Only personal user-entered names/areas/notes are stored outside the repository under ~/.maker-team/personal-places.json. No cookies, credentials, ratings, reviews, bulk Maps data, anti-bot or proxy capture; no network HTTP requests by the CLI itself.

Run on Node24/26 with local repo checkout:
node scripts/personal-places.mjs search 인천 송도 맛집
node scripts/personal-places.mjs add 'Restaurant Name' 'Incheon' restaurant
node scripts/personal-places.mjs list

These commands provide a generated official Google Maps search URL and private personal shortlist. Open the returned Google URL yourself to see current places, reviews, business hours, directions and availability in Google. The repo will not claim a business is currently open, rated or available for booking on the basis of a user-created note.

Library API import from src/argus/personalPlaces.js:
- directionsUrl([first,...,last], mode) formats official Google Maps directions URL for 2–9 manually supplied place names/areas; it does NOT calculate travel time or route distance.
- mapsSearchUrl(text) formats the official search URL.
- loadPlaces, savePlaces only accept schema maker-team-personal-places-v1 and USER_TYPED_ONLY provenance. Default DB outside repo.

Future personal UX target: optional filtered categories, map-side saved list and user-authorized route selection, if real personal usage warrants. No commercial lead collection and no mass scraping of Google data. For programmatic enrichment choose separately reviewed OSM/reuseable public providers or Google Places API subject to official licence/billing approval. User's personally entered favorites can be updated or cleared from local file. No actual personal entries were imported during this PR.

Acceptance: Node unit tests on no-network URL generator and local file; exact-head full CI; owner review; manual run on user's actual computer before declaring deployed. At creation time actual owner PC installation was NOT verified.