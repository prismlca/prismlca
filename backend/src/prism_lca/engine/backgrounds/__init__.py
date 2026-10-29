"""Background databases beyond ecoinvent.

The elementary-flow mapping comes first (it decides whether a second background database is
characterised at all), then the readers and the registry. Nothing in here writes to a Brightway
project; that stays with the importers.
"""
