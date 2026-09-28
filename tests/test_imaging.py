import pytest

from backend.imaging import import_manifest
from backend.samples import create_invalid_samples, create_valid_sample


def test_valid_synthetic_volume_preserves_identity_and_anisotropic_distance(tmp_path):
    identity = create_valid_sample(tmp_path)
    volume = __import__("backend.imaging", fromlist=["load_volume"]).load_volume(
        tmp_path / "volumes", identity["image_id"]
    )

    assert volume.shape == (9, 13, 17)
    assert volume.identity["content_domain"] == "synthetic research phantom"
    result = __import__("backend.imaging", fromlist=["distance_mm"]).distance_mm(
        volume, (4, 3, 2), (4, 5, 6)
    )
    assert result["distance_mm"] == pytest.approx((4.0**2 + 10.0**2) ** 0.5)


def test_missing_and_conflicting_orientation_are_rejected(tmp_path):
    samples = create_invalid_samples(tmp_path)
    with pytest.raises(Exception, match="缺失"):
        import_manifest(samples["missing_slice"], tmp_path / "volumes")
    with pytest.raises(Exception, match="冲突"):
        import_manifest(samples["orientation_conflict"], tmp_path / "volumes")
