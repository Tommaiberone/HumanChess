from smartchess.web.export import head_meta


def test_the_public_index_has_mode_csp_and_optional_proxy():
    plain = head_meta()
    assert 'content="browser"' in plain and "Content-Security-Policy" in plain
    assert "smartchess-llm" not in plain and "connect-src 'self' https://api.chess.com https://lichess.org;" in plain
    with_llm = head_meta("https://abc.lambda-url.eu-west-1.on.aws/")
    assert 'name="smartchess-llm" content="https://abc.lambda-url.eu-west-1.on.aws/"' in with_llm
    assert "https://lichess.org https://abc.lambda-url.eu-west-1.on.aws;" in with_llm
