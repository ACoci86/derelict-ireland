export type GeocodeConfidence = "council" | "exact" | "street" | "town" | "none"; // how sure are we about this pin's position on the map?

export interface Site {
  id: string;
  council: string;
  address: string;
  register_ref: string | null;
  eircode: string | null;
  description: string | null;
  date_entered: string | null;     // ISO format: "2023-04-01"
  lat: number | null;
  lon: number | null;
  geocode_confidence: GeocodeConfidence;
  source_url: string;
  retrieved: string;               // date we downloaded the source file
}

// The three fields every site MUST have; everything else gets a default.
type RequiredFields = Pick<Site, "id" | "council" | "address">;

export function makeSite(fields: RequiredFields & Partial<Site>): Site {
  return {
    register_ref: null,
    eircode: null,
    description: null,
    date_entered: null,
    lat: null,
    lon: null,
    geocode_confidence: "none",
    source_url: "",
    retrieved: "",
    ...fields,
  };
}

export function toFeature(s: Site) { // GeoJSON
  const { lat, lon, ...props } = s;   // pull coordinates out, keep the rest
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: props,
  };
}