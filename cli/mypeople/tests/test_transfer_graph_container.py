"""The app protocol carries a complete graph outside the small UI manifest."""
import copy
import io
import json
import zipfile

import pytest

from mypeople import transfer

SOURCE = "3ed3d6cb-aee4-478f-bb91-88dcd0783fa3"
GRAPH = {"collection": "1d921bee-687f-48e7-b84f-e04782a737d5", "heads": [], "commits": [], "blobs": {}}


def manifest():
    return {"format": 1, "type": "snapshot", "source": SOURCE, "revision": 1, "graph": copy.deepcopy(GRAPH)}


def test_graph_payload_is_separate_roundtrip_and_does_not_mutate_input():
    original = manifest()
    packed = transfer.pack(original)
    with zipfile.ZipFile(io.BytesIO(packed)) as archive:
        assert set(archive.namelist()) == {"manifest.json", "graph.json"}
        assert "graph" not in json.loads(archive.read("manifest.json"))
        assert json.loads(archive.read("graph.json")) == GRAPH
    assert original == transfer.unpack(packed)
    transfer.validate_inventory(original)  # graph collection need not equal transport source


@pytest.mark.parametrize("alter", [
    lambda m: m["graph"].update(heads=["not-a-uuid"]),
    lambda m: m["graph"].update(heads=[SOURCE, SOURCE]),
    lambda m: m["graph"].update(commits={}),
    lambda m: m["graph"].update(blobs={"not-a-hash": "aGVsbG8="}),
    lambda m: m["graph"].update(blobs={"0" * 64: None}),
    lambda m: m.update(graph=[]),
])
def test_graph_inventory_shape_is_checked(alter):
    value = manifest()
    alter(value)
    with pytest.raises(transfer.TransferError):
        transfer.validate_inventory(value)


def test_ambiguous_inline_and_external_graph_is_rejected():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest()))
        archive.writestr("graph.json", json.dumps(GRAPH))
    with pytest.raises(transfer.TransferError, match="graph"):
        transfer.unpack(output.getvalue())


def test_graph_expansion_bound_fails_instead_of_omitting_anything(monkeypatch):
    monkeypatch.setattr(transfer, "MAX_GRAPH", 10)
    with pytest.raises(transfer.TransferError, match="nothing was truncated"):
        transfer.pack(manifest())


def test_graph_tampering_is_authenticated():
    password = "synthetic-container-passphrase"
    encrypted = transfer.encrypt(transfer.pack(manifest()), password)
    tampered = encrypted[:-1] + bytes([encrypted[-1] ^ 1])
    with pytest.raises(transfer.TransferError, match="damaged"):
        transfer.decrypt(tampered, password)
