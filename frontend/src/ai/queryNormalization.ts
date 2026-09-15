/**
 * Query normalization and entity synonym mappings.
 */

import type { VehicleCategory, VehicleColorName } from "../../../shared/src/forensicTypes";

export const COLOR_SYNONYMS: Record<string, VehicleColorName> = {
  white: "White",
  ivory: "White",
  pearl: "White",
  black: "Black",
  dark: "Black",
  midnight: "Black",
  silver: "Silver",
  gray: "Silver",
  grey: "Silver",
  metallic: "Silver",
  slate: "Silver",
  red: "Red",
  crimson: "Red",
  maroon: "Red",
  ruby: "Red",
  scarlet: "Red",
  blue: "Blue",
  navy: "Blue",
  cyan: "Blue",
  azure: "Blue",
  indigo: "Blue",
  yellow: "Yellow",
  gold: "Yellow",
  golden: "Yellow",
  green: "Green",
  emerald: "Green",
  olive: "Green",
  orange: "Orange",
  amber: "Orange",
  brown: "Brown",
  chocolate: "Brown",
  bronze: "Brown",
  tan: "Brown",
  beige: "Brown",
};

export const CLASS_SYNONYMS: Record<string, VehicleCategory> = {
  // Cars
  car: "car",
  cars: "car",
  sedan: "car",
  sedans: "car",
  suv: "car",
  suvs: "car",
  hatchback: "car",
  hatchbacks: "car",
  automobile: "car",
  automobiles: "car",
  // Two-wheelers
  motorcycle: "motorcycle",
  motorcycles: "motorcycle",
  motorbike: "motorcycle",
  motorbikes: "motorcycle",
  bike: "motorcycle",
  bikes: "motorcycle",
  scooter: "motorcycle",
  scooters: "motorcycle",
  twowheeler: "motorcycle",
  twowheelers: "motorcycle",
  "two-wheeler": "motorcycle",
  "two-wheelers": "motorcycle",
  "two wheeler": "motorcycle",
  "two wheelers": "motorcycle",
  activa: "motorcycle",
  pulsar: "motorcycle",
  // Trucks
  truck: "truck",
  trucks: "truck",
  lorry: "truck",
  lorries: "truck",
  dumper: "truck",
  trailer: "truck",
  pickup: "truck",
  // Buses
  bus: "bus",
  buses: "bus",
  coach: "bus",
  coaches: "bus",
  minibus: "bus",
  // Auto-rickshaws
  auto: "autorickshaw",
  autos: "autorickshaw",
  rickshaw: "autorickshaw",
  rickshaws: "autorickshaw",
  autorickshaw: "autorickshaw",
  autorickshaws: "autorickshaw",
  "auto-rickshaw": "autorickshaw",
  "auto-rickshaws": "autorickshaw",
  "auto rickshaw": "autorickshaw",
  "auto rickshaws": "autorickshaw",
  // Vans
  van: "van",
  vans: "van",
  // Generic
  vehicle: "vehicle",
  vehicles: "vehicle",
};

/**
 * Normalizes query string for tokenization and entity matching.
 */
export function normalizeQueryText(query: string): string {
  return query
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\w\s-><=/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
