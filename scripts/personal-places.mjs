import { loadPlaces, manualPlace, savePlaces, mapsSearchUrl, defaultPlacesPath } from '../src/argus/personalPlaces.js';

const [command, ...parts] = process.argv.slice(2);
const db = defaultPlacesPath();
if (command === 'search') {
  console.log(mapsSearchUrl(parts.join(' ')));
} else if (command === 'list') {
  loadPlaces(db).then((items) => console.log(JSON.stringify(items, null, 2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else if (command === 'add') {
  const [name, area, category = 'restaurant'] = parts;
  loadPlaces(db).then(async (items) => {
    const item = manualPlace({ name, area, category });
    await savePlaces([...items, item], db);
    console.log(JSON.stringify({ id: item.id, name: item.name }));
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
} else {
  console.log('Usage: search QUERY | list | add NAME AREA [CATEGORY]');
}
