// The examples of the course, copied from https://github.com/acherm/dsl-langium (Langium 4.4).
import { CHUNO_GENERATOR, CHUNO_VALIDATOR, HELLO_GENERATOR, HELLO_VALIDATOR } from './example-code.ts';

export interface Example { name: string; grammar: string; programs: { name: string; text: string }[]; validator?: string; generator?: string }

export const EXAMPLES: Example[] = [
    {
        "name": "Hello world",
        "grammar": "grammar HelloWorld\n\nentry Model:\n    (persons+=Person | greetings+=Greeting)*;\n\nPerson:\n    'person' name=ID;\n\nGreeting:\n    'Hello' person=[Person:ID] '!';\n\nhidden terminal WS: /\\s+/;\nterminal ID: /[_a-zA-Z][\\w_]*/;\nterminal INT returns number: /[0-9]+/;\nterminal STRING: /\"(\\\\.|[^\"\\\\])*\"|'(\\\\.|[^'\\\\])*'/;\n\nhidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;\nhidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;\n",
        "programs": [
            {
                "name": "foo.hello",
                "text": "person Alice\nHello Alice !\n"
            }
        ]
    },
    {
        "name": "Chess",
        "grammar": "grammar ChessGame\n\nentry Game: \"White:\" whitePlayer=STRING \"Black:\" blackPlayer=STRING (moves+=Move)+;\n\nMove: AlgebraicMove | SpokenMove;\n\nAlgebraicMove: (piece=Piece)? source=Square (captures?='x')? dest=Square;\n\nSpokenMove: piece=Piece 'at' source=Square (captures?='captures' capturedPiece=Piece 'at' | 'moves_to') dest=Square;\n\n// regular expression ('a'..'h')('1'..'8');\nterminal Square: /[a-h][1-8]/; \n\nPiece returns string: Piece_PAWN | Piece_KNIGHT | Piece_BISHOP | Piece_ROOK | Piece_QUEEN | Piece_KING;\nPiece_PAWN returns string: 'P' | 'pawn';\nPiece_KNIGHT returns string: 'N' | 'knight'; // not K, because of King\nPiece_KING returns string: 'K' | 'king';\nPiece_BISHOP returns string: 'B' | 'bishop';\nPiece_QUEEN returns string: 'Q' | 'queen';\nPiece_ROOK returns string: 'R' | 'rook';\n\nhidden terminal WS: /\\s+/;\nterminal ID: /[_a-zA-Z][\\w_]*/;\nterminal STRING: /\"[^\"]*\"/;\n\nhidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;\nhidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;\n",
        "programs": [
            {
                "name": "demo.chess",
                "text": "White: \"INSA INFO5\"\nBlack: \"ChatGPT\"\ne2 e4\ne7 e5\nN g1 f3\nknight at b8 moves_to c6\n"
            }
        ]
    },
    {
        "name": "VideoGenerator",
        "grammar": "grammar VideoGenerator\n\nentry Model:\n    vids+=Video+\n    ; \n\nVideo : (Mandatory | Optional | Alternatives); \n\nMandatory : 'mandatory' video=VideoSeq;\nOptional : 'optional' video=VideoSeq; \n\nAlternatives : 'alternatives' id=ID '{' \n        videos+=VideoSeq+ \n    '}'; \n\nVideoSeq : 'videoseq' id=ID location=STRING;\n\nhidden terminal WS: /\\s+/;\nterminal ID: /[_a-zA-Z][\\w_]*/;\nterminal STRING: /\"[^\"]*\"|'[^']*'/;\n\nhidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;\nhidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;\n",
        "programs": [
            {
                "name": "demo.videogen",
                "text": "mandatory videoseq intro \"intro.mp4\"\noptional videoseq teaser \"teaser.mp4\"\nalternatives ending { videoseq e1 \"end1.mp4\" videoseq e2 \"end2.mp4\" }\n"
            }
        ]
    },
    {
        "name": "Poll",
        "grammar": "grammar PollSystem\n\nentry Model:\n    'PollSystem' '{' polls+=Poll+ '}';\n\nPoll:\n    'Poll' name=ID '{' questions+=Question+ '}';\n\nQuestion:\n    'Question' id=ID '{' text=STRING 'options' '{' options+=Option+ '}' '}';\n\nOption:\n    id=ID ':' text=STRING;\n\nhidden terminal WS: /\\s+/;\nterminal ID: /[_a-zA-Z][\\w_]*/;\nterminal STRING: /\"([^\"]*)\"/;\n\nhidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;\nhidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;\n",
        "programs": [
            {
                "name": "demo.poll",
                "text": "PollSystem {\n    Poll lunch {\n        Question q1 { \"Where do we eat today?\" options {\n            a: \"Cafeteria\"\n            b: \"Crêperie\"\n        } }\n        Question q2 { \"At what time?\" options {\n            noon: \"12:00\"\n            late: \"13:00\"\n        } }\n    }\n}\n"
            }
        ]
    }
];

// Chess-Uno (MiniChuno): chess where each turn starts with a card. Four programs: three games of
// the family, and one that the grammar must reject.
EXAMPLES.push({
    name: 'Chess-Uno',
    grammar: String.raw`grammar MiniChuno

// MiniChuno: chess where each turn starts with a card.
// Four things vary from one game to another:
//   1. which cards are in the deck, and how many
//   2. what each card does
//   3. how the game is won
//   4. what a check does to a series of moves

entry Game:
    'game' name=ID
    deck=Deck
    cards+=Card+
    'win' 'by' win=('checkmate' | 'capture')
    ('check' check=('ends' | 'continues') 'series')?;

Deck:
    'deck' '{' entries+=DeckEntry+ '}';

DeckEntry:
    count=INT 'x' card=[Card:ID];

Card:
    'card' name=ID ':' effect=Effect;

Effect: Move | Pass | Swap | Drop;

Move: 'move' count=INT;        // play ${'`'}count${'`'} chess moves in a row
Pass: {infer Pass} 'pass';     // lose the turn
Swap: {infer Swap} 'swap';     // the two players swap colours
Drop: {infer Drop} 'drop';     // put two captured pieces back on the board

hidden terminal WS: /\s+/;
terminal ID: /[_a-zA-Z][\w_]*/;
terminal INT returns number: /[0-9]+/;

hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
`,
    programs: [
        {
            name: 'video.chuno',
            text: `// The game of the "Chess Uno!" video.

game VideoChessUno

deck {
    8 x One     8 x Two      8 x Three    8 x Four
    8 x Skip    8 x Reverse  8 x DrawTwo
}

card One     : move 1
card Two     : move 2
card Three   : move 3
card Four    : move 4
card Skip    : pass
card Reverse : swap
card DrawTwo : drop

win by checkmate
check ends series
`,
        },
        {
            name: 'chess.chuno',
            text: `// Classical chess is the Chess-Uno whose deck holds a single card.

game ClassicalChess

deck {
    1 x One
}

card One : move 1

win by checkmate
`,
        },
        {
            name: 'blitz.chuno',
            text: `// An invented variant: three cards only, kings can be captured,
// and a check does not stop a series.

game BlitzChess

deck {
    12 x Step
    6 x Blitz
    6 x Nap
}

card Step  : move 1
card Blitz : move 2
card Nap   : pass

win by capture
check continues series
`,
        },
        {
            name: 'rejected.chuno',
            text: `// Rejected: the deck names a card that is declared nowhere.
// Not a syntax error: the cross-reference [Card:ID] cannot be resolved.

game Bad

deck {
    8 x One
    8 x Joker
}

card One : move 1

win by checkmate
`,
        },
    ],
    validator: CHUNO_VALIDATOR,
    generator: CHUNO_GENERATOR,
});

EXAMPLES[0].validator = HELLO_VALIDATOR;
EXAMPLES[0].generator = HELLO_GENERATOR;
