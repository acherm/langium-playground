grammar ChessFullGame

// A complete game of chess, in long algebraic notation: every move names the square it leaves
// and the square it reaches.
//
//     e2-e4        a pawn moves (no letter for a pawn)
//     Ng1-f3       a piece moves: K king, Q queen, R rook, B bishop, N knight
//     d4xe5        x instead of - when the move captures
//     O-O  O-O-O   castling, king side and queen side
//     e7-e8=Q      promotion
//     + and #      check and checkmate
//
// The grammar says how a game is written. Whether the moves are legal is the validator's job.

entry Game:
    'game' name=STRING
    ('white' white=STRING)?
    ('black' black=STRING)?
    ('event' event=STRING)?
    ('date' date=STRING)?
    turns+=Turn*
    ('result' result=Result)?;

// A turn: its number, White's move, then Black's (which can be missing at the end of the game).
Turn:
    number=INT '.' white=Move (black=Move)?;

Move: Castling | PieceMove;

Castling:
    side=('O-O-O' | 'O-O') Suffix;

PieceMove:
    (piece=Piece)? from=Square (capture?='x' | '-') to=Square ('=' promotion=Piece)? Suffix;

fragment Suffix:
    (check?='+' | mate?='#')?;

Piece returns string: 'K' | 'Q' | 'R' | 'B' | 'N';

Result returns string: '1-0' | '0-1' | '1/2-1/2' | '*';

terminal Square: /[a-h][1-8]/;
terminal INT returns number: /[0-9]+/;
terminal STRING: /"[^"]*"/;

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
