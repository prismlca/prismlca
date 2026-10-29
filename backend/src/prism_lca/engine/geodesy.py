"""Great-circle geometry on the WGS84 ellipsoid — the one distance ISO 14083 reserves for air freight.

Pure functions, no dependencies: the two callers (the sea endpoint's snap offsets, and the tests
that pin the sea network against a known relation) need a distance that is right to well under a
percent, and a 40-line Vincenty inverse gives ~0.5 mm without pulling pyproj/geographiclib into the
PyInstaller build. The Electron main process carries the same formula in TypeScript for the air and
rail modes (`frontend/src/main/distance/geo.ts`); if either changes, the other must.
"""
from __future__ import annotations

import math

# WGS84 (NIMA TR8350.2): semi-major axis, flattening, semi-minor axis.
_A = 6378137.0
_F = 1 / 298.257223563
_B = _A * (1 - _F)

# Mean Earth radius for the haversine fallback (IUGG); only used when Vincenty does not converge,
# which happens for nearly antipodal points and nowhere a freight leg goes.
_R_MEAN_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Spherical great-circle distance in km (mean radius). Fallback and sanity check."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dlmb = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * _R_MEAN_KM * math.asin(min(1.0, math.sqrt(h)))


def geodesic_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Ellipsoidal (WGS84) great-circle distance in km, Vincenty's inverse formula.

    Converges in a handful of iterations for any pair a transport leg can be; for the nearly
    antipodal pairs where it does not, the spherical answer is returned rather than an exception.
    """
    if lat1 == lat2 and lon1 == lon2:
        return 0.0
    u1 = math.atan((1 - _F) * math.tan(math.radians(lat1)))
    u2 = math.atan((1 - _F) * math.tan(math.radians(lat2)))
    big_l = math.radians(lon2 - lon1)
    sin_u1, cos_u1 = math.sin(u1), math.cos(u1)
    sin_u2, cos_u2 = math.sin(u2), math.cos(u2)

    lmb = big_l
    for _ in range(200):
        sin_lmb, cos_lmb = math.sin(lmb), math.cos(lmb)
        sin_sigma = math.sqrt(
            (cos_u2 * sin_lmb) ** 2 + (cos_u1 * sin_u2 - sin_u1 * cos_u2 * cos_lmb) ** 2
        )
        if sin_sigma == 0:
            return 0.0
        cos_sigma = sin_u1 * sin_u2 + cos_u1 * cos_u2 * cos_lmb
        sigma = math.atan2(sin_sigma, cos_sigma)
        sin_alpha = cos_u1 * cos_u2 * sin_lmb / sin_sigma
        cos2_alpha = 1 - sin_alpha**2
        # Equatorial line: cos²α = 0 and the correction term is zero by definition.
        cos_2sm = cos_sigma - 2 * sin_u1 * sin_u2 / cos2_alpha if cos2_alpha else 0.0
        c = _F / 16 * cos2_alpha * (4 + _F * (4 - 3 * cos2_alpha))
        prev = lmb
        lmb = big_l + (1 - c) * _F * sin_alpha * (
            sigma + c * sin_sigma * (cos_2sm + c * cos_sigma * (-1 + 2 * cos_2sm**2))
        )
        if abs(lmb - prev) < 1e-12:
            break
    else:
        return haversine_km(lat1, lon1, lat2, lon2)

    u_sq = cos2_alpha * (_A**2 - _B**2) / _B**2
    a_coef = 1 + u_sq / 16384 * (4096 + u_sq * (-768 + u_sq * (320 - 175 * u_sq)))
    b_coef = u_sq / 1024 * (256 + u_sq * (-128 + u_sq * (74 - 47 * u_sq)))
    delta_sigma = (
        b_coef
        * sin_sigma
        * (
            cos_2sm
            + b_coef
            / 4
            * (
                cos_sigma * (-1 + 2 * cos_2sm**2)
                - b_coef / 6 * cos_2sm * (-3 + 4 * sin_sigma**2) * (-3 + 4 * cos_2sm**2)
            )
        )
    )
    return _B * a_coef * (sigma - delta_sigma) / 1000.0
