from smartchess.web.export import build_id, head_meta


def test_the_public_index_has_mode_csp_and_optional_proxy():
    plain = head_meta()
    assert 'content="browser"' in plain and "Content-Security-Policy" in plain
    assert "smartchess-llm" not in plain and "connect-src 'self' https://api.chess.com https://lichess.org;" in plain
    with_llm = head_meta("https://abc.lambda-url.eu-west-1.on.aws/")
    assert 'name="smartchess-llm" content="https://abc.lambda-url.eu-west-1.on.aws/"' in with_llm
    assert "https://lichess.org https://abc.lambda-url.eu-west-1.on.aws;" in with_llm
    assert "smartchess-stats" not in plain
    with_stats = head_meta(stats_url="https://def.lambda-url.eu-west-1.on.aws/")
    assert 'name="smartchess-stats" content="https://def.lambda-url.eu-west-1.on.aws/"' in with_stats
    assert "https://lichess.org https://def.lambda-url.eu-west-1.on.aws;" in with_stats
    assert "smartchess-build" not in plain
    assert '<meta name="smartchess-build" content="1a2b3c4d">' in head_meta(build="1a2b3c4d")


def test_the_build_changes_with_the_code(tmp_path):
    (tmp_path / "app.js").write_text("one", encoding="utf-8")
    (tmp_path / "model.onnx").write_bytes(b"weights")
    first = build_id(tmp_path, "<html>")
    (tmp_path / "model.onnx").write_bytes(b"other weights")
    assert build_id(tmp_path, "<html>") == first  # only the code counts
    (tmp_path / "app.js").write_text("two", encoding="utf-8")
    assert build_id(tmp_path, "<html>") != first
    assert len(first) == 8
