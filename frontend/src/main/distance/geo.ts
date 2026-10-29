/**
 * Great-circle distance on the WGS84 ellipsoid — the distance ISO 14083 reserves for air freight and
 * the base for the rail estimate. Vincenty's inverse formula; the spherical haversine is the fallback
 * for the nearly antipodal pairs where Vincenty does not converge (no freight leg is one).
 *
 * The Python backend carries the same formula (`engine/geodesy.py`) for the sea endpoint's snap
 * offsets; if either changes, the other must.
 */
const A = 6378137.0
const F = 1 / 298.257223563
const B = A * (1 - F)
const R_MEAN_KM = 6371.0088

const rad = (d: number): number => (d * Math.PI) / 180

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = rad(lat1)
  const p2 = rad(lat2)
  const dphi = p2 - p1
  const dlmb = rad(lon2 - lon1)
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2
  return 2 * R_MEAN_KM * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function geodesicKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  if (lat1 === lat2 && lon1 === lon2) return 0
  const u1 = Math.atan((1 - F) * Math.tan(rad(lat1)))
  const u2 = Math.atan((1 - F) * Math.tan(rad(lat2)))
  const L = rad(lon2 - lon1)
  const sinU1 = Math.sin(u1)
  const cosU1 = Math.cos(u1)
  const sinU2 = Math.sin(u2)
  const cosU2 = Math.cos(u2)

  let lambda = L
  let sinSigma = 0
  let cosSigma = 0
  let sigma = 0
  let cos2Alpha = 0
  let cos2Sm = 0
  let converged = false
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda)
    const cosL = Math.cos(lambda)
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2)
    if (sinSigma === 0) return 0
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma
    cos2Alpha = 1 - sinAlpha ** 2
    cos2Sm = cos2Alpha ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0
    const c = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha))
    const prev = lambda
    lambda =
      L + (1 - c) * F * sinAlpha * (sigma + c * sinSigma * (cos2Sm + c * cosSigma * (-1 + 2 * cos2Sm ** 2)))
    if (Math.abs(lambda - prev) < 1e-12) {
      converged = true
      break
    }
  }
  if (!converged) return haversineKm(lat1, lon1, lat2, lon2)

  const uSq = (cos2Alpha * (A ** 2 - B ** 2)) / B ** 2
  const aCoef = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)))
  const bCoef = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)))
  const deltaSigma =
    bCoef *
    sinSigma *
    (cos2Sm +
      (bCoef / 4) *
        (cosSigma * (-1 + 2 * cos2Sm ** 2) -
          (bCoef / 6) * cos2Sm * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2Sm ** 2)))
  return (B * aCoef * (sigma - deltaSigma)) / 1000
}
