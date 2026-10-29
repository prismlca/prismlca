"""Custom LCIA method management (project-scoped). Shipped methods are read-only; users duplicate
them into editable copies, tweak factors/flows, and organise them into named families."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from prism_lca.api.v1.deps import require_token
from prism_lca.engine import lcia_methods

router = APIRouter(prefix="/lcia", tags=["lcia"], dependencies=[Depends(require_token)])


class DuplicateRequest(BaseModel):
    src: list[str]
    family: str
    name: str
    description: str | None = None


class NewMethodRequest(BaseModel):
    family: str
    name: str
    unit: str = ""
    description: str | None = None


class MethodRequest(BaseModel):
    method: list[str]


class FactorRequest(BaseModel):
    method: list[str]
    ref: int | str | list[str]
    cf: float


class RemoveFlowRequest(BaseModel):
    method: list[str]
    ref: int | str | list[str]


class FamilyRequest(BaseModel):
    family: str
    description: str = ""


@router.get("/families", summary="All method families with their indicators (editable = custom)")
def families() -> dict:
    return lcia_methods.list_families()


@router.post("/method-flows", summary="A method's flows and characterisation factors")
def method_flows(body: MethodRequest) -> dict:
    return lcia_methods.method_flows(body.method)


@router.post("/duplicate", summary="Duplicate a method into an editable copy")
def duplicate(body: DuplicateRequest) -> dict:
    return lcia_methods.duplicate_method(body.src, body.family, body.name, body.description)


@router.post("/method", summary="Create an empty custom method")
def new_method(body: NewMethodRequest) -> dict:
    return lcia_methods.create_method(body.family, body.name, body.unit, body.description)


class RenameMethodRequest(BaseModel):
    method: list[str]
    name: str


@router.post("/method/rename", summary="Rename a custom method")
def rename_method(body: RenameMethodRequest) -> dict:
    return lcia_methods.rename_method(body.method, body.name)


@router.post("/factor", summary="Set (or add) a flow's factor in a custom method")
def factor(body: FactorRequest) -> dict:
    return lcia_methods.set_factor(body.method, body.ref, body.cf)


@router.post("/flow/remove", summary="Remove a flow from a custom method")
def remove_flow(body: RemoveFlowRequest) -> dict:
    return lcia_methods.remove_flow(body.method, body.ref)


@router.post("/delete", summary="Delete a custom method")
def delete(body: MethodRequest) -> dict:
    return lcia_methods.delete_method(body.method)


@router.post("/family", summary="Create or update a family's description")
def family(body: FamilyRequest) -> dict:
    return lcia_methods.set_family(body.family, body.description)


class FamilyNameRequest(BaseModel):
    family: str


class EditFamilyRequest(BaseModel):
    old: str
    name: str
    description: str = ""


@router.post("/family/edit", summary="Rename a custom family and/or set its description")
def edit_family(body: EditFamilyRequest) -> dict:
    return lcia_methods.edit_family(body.old, body.name, body.description)


@router.post("/family/delete", summary="Delete a custom family and its methods")
def delete_family(body: FamilyNameRequest) -> dict:
    return lcia_methods.delete_family(body.family)


@router.get("/flow-search", summary="Search biosphere flows (add-flow autocomplete)")
def flow_search(query: str | None = None, limit: int = 30) -> dict:
    return lcia_methods.flow_search(query, limit)
