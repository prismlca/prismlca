"""Sea distances endpoint and the geodesy it leans on. No project fixture: pure geometry."""
from __future__ import annotations

import pytest

from prism_lca.engine.geodesy import geodesic_km, haversine_km

# Frankfurt airport → Shanghai Pudong, a relation whose great-circle distance is published by every
# airline route table at ~8 850 km.
FRA = (50.033, 8.570)
PVG = (31.144, 121.808)


def test_geodesic_matches_published_great_circle():
    km = geodesic_km(*FRA, *PVG)
    assert 8_800 < km < 8_900
    # The sphere is within half a percent of the ellipsoid; if it is not, one of the two is broken.
    assert abs(km - haversine_km(*FRA, *PVG)) / km < 0.005


def test_geodesic_agrees_with_the_typescript_twin():
    # frontend/src/main/distance/geo.test.ts pins the same pair to the same figure.
    assert round(geodesic_km(49.41, 8.68, 53.55, 9.99), 2) == 469.49


def test_geodesic_degenerate_cases():
    assert geodesic_km(49.4, 8.7, 49.4, 8.7) == 0.0
    # Antipodal-ish: Vincenty may not converge and must fall back rather than raise.
    assert 19_000 < geodesic_km(0.0, 0.0, 0.5, 179.7) < 20_100


def test_sea_shanghai_rotterdam_via_suez(client, token):
    body = {"legs": [{"from": {"lat": 31.23, "lon": 121.47}, "to": {"lat": 51.92, "lon": 4.48}}]}
    r = client.post("/api/v1/distances/sea", json=body, headers=token)
    assert r.status_code == 200, r.text
    leg = r.json()["legs"][0]
    # The published Suez figure for this pair is 10 600–10 700 nm ≈ 19 600–19 800 km.
    assert 19_000 < leg["km"] < 20_500
    assert "suez" in leg["passages"]
    # Both ports sit on the network: the snap offsets are a few tens of km at most.
    assert leg["from_snap_km"] < 60 and leg["to_snap_km"] < 30
    assert leg["error"] is None
    assert "searoute" in r.json()["source"]


def test_sea_via_cape_blocks_suez_and_panama(client, token):
    body = {
        "legs": [
            {"from": {"lat": 31.23, "lon": 121.47}, "to": {"lat": 51.92, "lon": 4.48}, "via": "cape"}
        ]
    }
    r = client.post("/api/v1/distances/sea", json=body, headers=token)
    assert r.status_code == 200, r.text
    leg = r.json()["legs"][0]
    # Round Africa: the published Cape figure for this pair is ~13 800 nm ≈ 25 500 km.
    assert 25_000 < leg["km"] < 26_500
    assert "south_africa" in leg["passages"]
    assert "suez" not in leg["passages"] and "panama" not in leg["passages"]
    assert leg["via"] == "cape"
    bad = {"legs": [{"from": {"lat": 0, "lon": 0}, "to": {"lat": 1, "lon": 1}, "via": "teleport"}]}
    assert client.post("/api/v1/distances/sea", json=bad, headers=token).status_code == 422


def test_sea_inland_origin_reports_snap_separately(client, token):
    # Heidelberg is 400+ km from the nearest seaport; the ship's km must not swallow that leg.
    body = {"legs": [{"from": {"lat": 49.41, "lon": 8.68}, "to": {"lat": 40.7, "lon": -74.0}}]}
    r = client.post("/api/v1/distances/sea", json=body, headers=token)
    assert r.status_code == 200, r.text
    leg = r.json()["legs"][0]
    assert 5_500 < leg["km"] < 7_500
    assert leg["from_snap_km"] > 300
    assert leg["to_snap_km"] < 60


def test_sea_batch_and_validation(client, token):
    body = {
        "legs": [
            {"from": {"lat": 31.23, "lon": 121.47}, "to": {"lat": 51.92, "lon": 4.48}},
            {"from": {"lat": 51.92, "lon": 4.48}, "to": {"lat": 51.92, "lon": 4.48}},
        ]
    }
    r = client.post("/api/v1/distances/sea", json=body, headers=token)
    assert r.status_code == 200, r.text
    legs = r.json()["legs"]
    assert len(legs) == 2
    assert legs[1]["km"] == 0.0

    r = client.post("/api/v1/distances/sea", json={"legs": []}, headers=token)
    assert r.status_code == 422
    bad = {"legs": [{"from": {"lat": 95, "lon": 0}, "to": {"lat": 0, "lon": 0}}]}
    assert client.post("/api/v1/distances/sea", json=bad, headers=token).status_code == 422


def test_sea_two_places_on_one_node_is_an_error_not_zero(client, token):
    # Two points a few hundred metres apart in the Rotterdam port area share their network node. The
    # empty route used to come back as 0 km — "no transport" for a leg between two different places.
    body = {"legs": [{"from": {"lat": 51.92, "lon": 4.48}, "to": {"lat": 51.921, "lon": 4.481}}]}
    leg = client.post("/api/v1/distances/sea", json=body, headers=token).json()["legs"][0]
    assert leg["km"] is None
    assert "same shipping-lane node" in leg["error"]


def test_sea_across_the_antimeridian_keeps_small_snaps(client, token):
    # Shanghai → Los Angeles crosses 180°; searoute unrolls the longitude (e.g. 241°). The snap offsets
    # are measured on normalised coordinates and stay small.
    body = {"legs": [{"from": {"lat": 31.23, "lon": 121.47}, "to": {"lat": 33.74, "lon": -118.27}}]}
    leg = client.post("/api/v1/distances/sea", json=body, headers=token).json()["legs"][0]
    assert 9_000 < leg["km"] < 12_500
    assert leg["from_snap_km"] < 60 and leg["to_snap_km"] < 60


def test_catalogue_codes_and_named_terminals():
    from prism_lca.engine.transport_catalogue import AmbiguousTerminal, resolve

    assert resolve("airport", "FRA").code == "FRA"
    assert resolve("airport", "EDDF").code == "FRA"  # ICAO
    # Codes are case-sensitive, so an ordinary word never turns into an airport.
    assert resolve("airport", "Fra") is None
    # The Pelias failure this catalogue exists for (hotel next to the terminal).
    assert resolve("airport", "Shanghai Pudong Airport").code == "PVG"
    assert resolve("port", "DEHAM").code == "DEHAM"
    assert resolve("port", "Hamburg (DEHAM, DE)").code == "DEHAM"  # the panel's own label
    assert resolve("port", "Port of Hamburg", "DE").code == "DEHAM"
    # No airport/port word: a place for the geocoder, not a terminal.
    assert resolve("port", "Hamburg") is None
    # "London Airport" is also an airport in Ontario — an exact name must not win over Heathrow & co.
    with pytest.raises(AmbiguousTerminal, match="Pass the code"):
        resolve("airport", "London airport")
    with pytest.raises(AmbiguousTerminal):
        resolve("port", "Portland port")


def test_catalogue_namesakes_far_apart_are_refused_even_in_one_country():
    from prism_lca.engine.transport_catalogue import AmbiguousTerminal, resolve

    # A "sole major airport in the country" shortcut turned La Palma (SPC)
    # into Palma de Mallorca (PMI), 2 238 km away, and one Rochester into the other.
    with pytest.raises(AmbiguousTerminal, match="SPC"):
        resolve("airport", "La Palma Airport")
    with pytest.raises(AmbiguousTerminal, match="RST"):
        resolve("airport", "Rochester International Airport")
    # One terminal listed next to a neighbour a few km off stays one answer.
    assert resolve("port", "Port of Hamburg", "DE").code == "DEHAM"


def test_catalogue_shared_port_codes_never_pick_a_coast():
    from prism_lca.engine.transport_catalogue import AmbiguousTerminal, ports, resolve, suggest

    # USPWM is listed for Portland, Maine AND Portland, Oregon: the code
    # alone is refused, and each suggestion label resolves to its OWN coordinates.
    with pytest.raises(AmbiguousTerminal, match="exact label"):
        resolve("port", "USPWM")
    entries = [t for t in ports() if t.code == "USPWM"]
    assert len({(t.lat, t.lon) for t in entries}) == 2
    for t in entries:
        hit = resolve("port", t.label)
        assert (hit.lat, hit.lon) == (t.lat, t.lon)
    # And every suggestion label round-trips to the entry it was made from.
    for t in suggest("port", "portland"):
        assert (resolve("port", t.label).lat, resolve("port", t.label).lon) == (t.lat, t.lon)


def test_places_endpoints(client, token):
    body = {"kind": "airport", "items": [{"text": "PVG"}, {"text": "London airport"}, {"text": "Ulm"}]}
    r = client.post("/api/v1/distances/places/resolve", json=body, headers=token)
    assert r.status_code == 200, r.text
    items = r.json()["items"]
    assert items[0]["match"]["code"] == "PVG" and items[0]["error"] is None
    assert items[1]["match"] is None and "several airports" in items[1]["error"]
    assert items[2] == {"match": None, "error": None}
    assert "OurAirports" in r.json()["source"]

    r = client.get("/api/v1/distances/places/suggest?kind=port&q=rotter", headers=token)
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["code"] == "NLRTM"
    r = client.get("/api/v1/distances/places/suggest?kind=port&q=hamb&major_only=true", headers=token)
    assert all(i["major"] for i in r.json()["items"])


@pytest.mark.parametrize("path", ["/api/v1/distances/sea"])
def test_sea_requires_token(client, path):
    body = {"legs": [{"from": {"lat": 0, "lon": 0}, "to": {"lat": 1, "lon": 1}}]}
    assert client.post(path, json=body).status_code in (401, 403)


def test_places_nearest_major_terminal(client, token):
    # Heidelberg: the nearest LARGE airport is Frankfurt (~ 70 km), not the Mannheim airstrip.
    body = {"kind": "airport", "points": [{"lat": 49.41, "lon": 8.69}]}
    r = client.post("/api/v1/distances/places/nearest", json=body, headers=token)
    assert r.status_code == 200, r.text
    item = r.json()["items"][0]
    assert item["terminal"]["code"] == "FRA" and 50 < item["km"] < 90
    body = {"kind": "port", "points": [{"lat": 53.55, "lon": 9.99}]}
    item = client.post("/api/v1/distances/places/nearest", json=body, headers=token).json()["items"][0]
    assert item["terminal"]["code"] == "DEHAM" and item["terminal"]["major"]


def test_nearest_port_skips_ports_far_from_the_sea_network():
    from prism_lca.engine.transport_catalogue import (
        AUTO_PORT_MAX_NETWORK_KM,
        nearest,
        port_network_km,
    )

    # Wuhan's own terminal lies 535 km up the Yangtze from the network:
    # never the automatic pick — that stretch would be in no leg.
    t, _ = nearest("port", 30.59, 114.3)
    assert port_network_km(t) <= AUTO_PORT_MAX_NETWORK_KM
    # And no landlocked country's river port for Prague.
    assert nearest("port", 50.08, 14.44)[0].country != "SK"


def test_nearest_reports_the_entry_a_point_lies_on(client, token):
    from prism_lca.engine.transport_catalogue import ports

    maine = next(t for t in ports() if t.code == "USPWM" and "Me" in t.name)
    body = {"kind": "port", "points": [{"lat": maine.lat, "lon": maine.lon}]}
    item = client.post("/api/v1/distances/places/nearest", json=body, headers=token).json()["items"][0]
    # The nearest MAJOR port may be Boston; the point itself is Portland, Maine.
    assert item["at"]["label"] == maine.label


def test_resolve_takes_coordinates_that_lie_on_a_terminal():
    from prism_lca.engine.transport_catalogue import airports, resolve

    fra = next(a for a in airports() if a.code == "FRA")
    assert resolve("airport", f"{fra.lat}, {fra.lon}").code == "FRA"
    assert resolve("airport", "49.41, 8.69") is None  # Heidelberg is a place, not an airport


def test_places_require_token(client):
    body = {"kind": "port", "items": [{"text": "DEHAM"}]}
    assert client.post("/api/v1/distances/places/resolve", json=body).status_code in (401, 403)
    assert client.get("/api/v1/distances/places/suggest?kind=port&q=ham").status_code in (401, 403)
