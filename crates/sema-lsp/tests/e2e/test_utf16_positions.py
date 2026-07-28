"""UTF-16 position-encoding wire coverage (LSP-CI-1).

LSP positions count UTF-16 code units. An astral-plane character (one char,
TWO UTF-16 units, FOUR UTF-8 bytes) placed before a symbol makes the three
interpretations disagree, so these tests fail if the server ever counts chars
or bytes instead:

    (define pre "\U0001f600\U0001f600") (define target-sym 42)
     utf-16 columns: "(define pre \"" = 13, emoji = 4, "\") " = 3 -> the second
     define opens at column 20; `target-sym` spans columns 28..38.
     (chars would say 26..36; utf-8 bytes 32..42.)
"""

import pytest
from lsprotocol.types import (
    DefinitionParams,
    Position,
    TextDocumentIdentifier,
)
from pytest_lsp import LanguageClient

from helpers import open_doc

DOC = '(define pre "\U0001f600\U0001f600") (define target-sym 42)\n(println "\U0001f600" target-sym)'


@pytest.mark.asyncio
async def test_server_advertises_utf16_position_encoding(client: LanguageClient):
    """The server must declare the position encoding it actually speaks."""
    caps = client.server_capabilities
    assert caps is not None
    assert caps.position_encoding == "utf-16"


@pytest.mark.asyncio
async def test_definition_across_astral_chars_uses_utf16_columns(
    client: LanguageClient,
):
    """Request AND response positions must be UTF-16 across astral chars.

    The request cursor sits on the LAST unit of `target-sym`'s usage on line 1
    (utf-16 column 23: after `(println "` = 10, the emoji = 2, `" ` = 2, then
    9 units into the symbol). A char-counting server reads column 23 as one
    past the symbol and finds nothing. The asserted response range (28..38 on
    line 0) sits after the two emoji, so a byte- or char-counting server
    reports it shifted.
    """
    uri = await open_doc(client, DOC)
    result = await client.text_document_definition_async(
        DefinitionParams(
            text_document=TextDocumentIdentifier(uri=uri),
            position=Position(line=1, character=23),
        )
    )
    assert result is not None
    loc = result[0] if isinstance(result, list) else result
    assert loc.range.start.line == 0
    assert loc.range.start.character == 28, (
        f"definition start must be utf-16 column 28, got {loc.range.start.character}"
    )
    assert loc.range.end.character == 38, (
        f"definition end must be utf-16 column 38, got {loc.range.end.character}"
    )
