import importlib

from backend.imaging import MeasurementRequest, VoxelPoint


def test_end_to_end_slice_measurement_and_session(tmp_path, monkeypatch):
    monkeypatch.setenv("IMAGING_DATA_ROOT", str(tmp_path))
    import backend.main as main

    importlib.reload(main)

    image = main.import_built_in_valid_sample()
    assert image["shape"] == [9, 13, 17]

    slice_payload = main.get_slice(image["image_id"], 1, 6)
    assert slice_payload["width"] == 17
    assert slice_payload["png_base64"].startswith("iVBOR")

    measurement = main.create_measurement(
        image["image_id"],
        MeasurementRequest(
            label="空间距离",
            point_a=VoxelPoint(ijk=(4, 3, 2)),
            point_b=VoxelPoint(ijk=(4, 5, 6)),
        ),
    )
    assert measurement["distance_mm"] == 10.77033

    record = {**measurement, "id": "m1", "label": "空间距离 1"}
    state = {"crosshair": [4, 5, 6], "measurements": [record]}
    saved = main.save_session(
        "case-1", main.SessionPayload(image_id=image["image_id"], state=state)
    )
    assert saved["state"]["crosshair"] == [4, 5, 6]
    restored = main.get_session("case-1")
    assert restored["image_id"] == image["image_id"]

    invalid = main.check_invalid_samples()
    assert invalid["missing_slice"]["accepted"] is False
    assert invalid["orientation_conflict"]["accepted"] is False
