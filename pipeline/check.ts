import { makeSite, toFeature } from "./schema";

const s = makeSite({
  id: "test-1",
  council: "Test Council",
  address: "1 Main Street, Testtown",
  lat: 53.3,
  lon: -6.2,
  geocode_confidence: "council",
});

console.log(s);
console.log(toFeature(s));