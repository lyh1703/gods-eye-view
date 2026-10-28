import { manualPlace, mapsSearchUrl } from '../src/argus/personalPlaces.js';
import {
  defaultPlacesPath,
  loadPlaces,
  savePlaces,
} from './personal-places-storage.mjs';

async function main(argv) {
  const [command, ...parts] = argv;
  const db = defaultPlacesPath();
  if (command === 'search') {
    console.log(mapsSearchUrl(parts.join(' ')));
    return;
  }
  if (command === 'list') {
    const items = await loadPlaces(db);
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (command === 'add') {
    const [name, area, category = 'restaurant'] = parts;
    const items = await loadPlaces(db);
    const item = manualPlace({ name, area, category });
    await savePlaces([...items, item], db);
    console.log(JSON.stringify({ id: item.id, name: item.name }));
    return;
  }
  console.log('Usage: search QUERY | list | add NAME AREA [CATEGORY]');
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
