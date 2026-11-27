import type { ValidationAcceptor, ValidationChecks } from 'langium';
import type { ChessFullGameAstType, Game, Move, PieceMove } from './generated/ast.js';
import { isCastling } from './generated/ast.js';
import type { ChessFullGameServices } from './chess-full-game-module.js';

/**
 * Register custom validation checks: for each type of node, the method that checks it.
 */
export function registerValidationChecks(services: ChessFullGameServices) {
    const registry = services.validation.ValidationRegistry;
    const validator = services.validation.ChessFullGameValidator;
    const checks: ValidationChecks<ChessFullGameAstType> = {
        Game: validator.checkGame,
        PieceMove: validator.checkPromotionPiece
    };
    registry.register(checks, validator);
}

/**
 * What the grammar cannot say: that the moves are legal chess, and that the notation tells the
 * truth (x when a piece is captured, + for a check, # for a checkmate, a result that fits).
 */
export class ChessFullGameValidator {

    /** A check on one node, without context. */
    checkPromotionPiece(move: PieceMove, accept: ValidationAcceptor): void {
        if (move.promotion === 'K') {
            accept('error', 'A pawn cannot be promoted to a king.', { node: move, property: 'promotion' });
        }
    }

    /** A check on the whole game: the moves are replayed on a board, one after the other. */
    checkGame(game: Game, accept: ValidationAcceptor): void {
        game.turns.forEach((turn, index) => {
            if (turn.number !== index + 1) {
                accept('warning', `This is turn ${index + 1}, not ${turn.number}.`, { node: turn, property: 'number' });
            }
            if (!turn.black && index < game.turns.length - 1) {
                accept('error', "Black's move is missing: only the last turn can stop after White's move.", { node: turn });
            }
        });

        let position = initialPosition();
        let over = '';      // 'checkmate' or 'stalemate' once the game has ended
        for (const move of movesOf(game)) {
            if (over) {
                accept('error', `The game is over (${over}): no move can follow.`, { node: move });
                return;
            }
            const next = this.checkMove(move, position, accept);
            if (!next) return;      // an illegal move: the position is unknown from here on
            position = next;
            if (!hasLegalMove(position)) over = inCheck(position.board, position.turn) ? 'checkmate' : 'stalemate';
        }

        // The result must fit how the game ended. (Without checkmate, a player may have resigned.)
        if (game.result && over === 'checkmate') {
            const expected = position.turn === 'b' ? '1-0' : '0-1';
            if (game.result !== expected) {
                accept('error', `${sideName(other(position.turn))} gave checkmate: the result is ${expected}.`, { node: game, property: 'result' });
            }
        }
        if (game.result && over === 'stalemate' && game.result !== '1/2-1/2') {
            accept('error', 'The game ends in stalemate: the result is 1/2-1/2.', { node: game, property: 'result' });
        }
    }

    /** Checks one move in a position. Returns the position after it, or undefined if it is illegal. */
    private checkMove(move: Move, position: Position, accept: ValidationAcceptor): Position | undefined {
        const step = toStep(move, position.turn);
        const reason = whyNot(position, step)
            ?? (inCheck(play(position, step).board, position.turn) ? `This move leaves the ${sideName(position.turn).toLowerCase()} king in check.` : undefined);
        if (reason) {
            accept('error', `${reason} The moves that follow are not checked.`, { node: move });
            return undefined;
        }

        // The move is legal. Does the notation describe it correctly?
        if (!isCastling(move)) {
            const piece = position.board[step.from].toUpperCase();
            const written = move.piece ?? 'P';
            if (written !== piece) {
                accept('error', `The piece on ${move.from} is a ${NAMES[piece]}: write ${piece === 'P' ? '' : piece}${move.from}, not ${move.piece ?? ''}${move.from}.`,
                    { node: move, property: move.piece ? 'piece' : 'from' });
            }
            const captures = position.board[step.to] !== '' || (piece === 'P' && step.to === position.enPassant);
            if (captures && !move.capture) {
                accept('warning', `This move captures: write ${move.from}x${move.to}.`, { node: move, property: 'to' });
            }
            if (!captures && move.capture) {
                accept('error', `Nothing is captured on ${move.to}: write ${move.from}-${move.to}.`, { node: move, property: 'capture' });
            }
        }
        const next = play(position, step);
        const check = inCheck(next.board, next.turn);
        const mate = check && !hasLegalMove(next);
        if (mate && !move.mate) {
            accept('warning', 'This move is checkmate: mark it with #.', { node: move });
        } else if (!mate && move.mate) {
            accept('error', check ? 'This is check, but not checkmate: there is a way out.' : 'This is not checkmate: the king is not in check.', { node: move, property: 'mate' });
        } else if (check && !mate && !move.check) {
            accept('warning', 'This move gives check: mark it with +.', { node: move });
        } else if (!check && move.check) {
            accept('error', 'This move does not give check.', { node: move, property: 'check' });
        }
        return next;
    }
}

// ---------------------------------------------------------------------------------------------
// The rules of chess, independent of Langium: a position, and what a move does to it.
// The generator imports this part to replay the game.
// ---------------------------------------------------------------------------------------------

export type Side = 'w' | 'b';

/**
 * A position. `board` has 64 squares, a1 first, then b1 ... h1, a2 ... h8. A square holds '' or the
 * letter of a piece: upper case for White (KQRBNP), lower case for Black. `castling` lists the
 * castlings still allowed, among K Q (White, king and queen side) and k q (Black). `enPassant` is
 * the square a pawn has just jumped over, or -1.
 */
export interface Position { board: string[]; turn: Side; castling: string; enPassant: number }

/** A move as the board sees it: a piece leaves a square for another. Castling is a king moving two squares. */
export interface Step { from: number; to: number; promotion?: string }

const FILES = 'abcdefgh';
const NAMES: Record<string, string> = { K: 'king', Q: 'queen', R: 'rook', B: 'bishop', N: 'knight', P: 'pawn' };

export function square(name: string): number { return FILES.indexOf(name.charAt(0)) + 8 * (Number(name.charAt(1)) - 1); }
export function squareName(index: number): string { return FILES.charAt(index % 8) + (Math.floor(index / 8) + 1); }
export function sideOf(piece: string): Side { return piece === piece.toUpperCase() ? 'w' : 'b'; }
export function other(side: Side): Side { return side === 'w' ? 'b' : 'w'; }
export function sideName(side: Side): string { return side === 'w' ? 'White' : 'Black'; }

export function initialPosition(): Position {
    const back = 'RNBQKBNR';
    const board = new Array<string>(64).fill('');
    for (let file = 0; file < 8; file++) {
        board[file] = back.charAt(file);
        board[8 + file] = 'P';
        board[48 + file] = 'p';
        board[56 + file] = back.charAt(file).toLowerCase();
    }
    return { board, turn: 'w', castling: 'KQkq', enPassant: -1 };
}

/** The moves of a game in the order they are played. */
export function movesOf(game: Game): Move[] {
    return game.turns.flatMap(turn => turn.black ? [turn.white, turn.black] : [turn.white]);
}

/** From the notation to the board: which square is left, which one is reached. */
export function toStep(move: Move, turn: Side): Step {
    if (isCastling(move)) {
        const home = turn === 'w' ? 4 : 60;     // e1 or e8
        return { from: home, to: home + (move.side === 'O-O' ? 2 : -2) };
    }
    return { from: square(move.from), to: square(move.to), promotion: move.promotion };
}

/** A move as it is written: the label shown next to the board. */
export function notation(move: Move): string {
    const suffix = move.mate ? '#' : move.check ? '+' : '';
    if (isCastling(move)) return move.side + suffix;
    return (move.piece ?? '') + move.from + (move.capture ? 'x' : '-') + move.to + (move.promotion ? '=' + move.promotion : '') + suffix;
}

/** Whether every square strictly between two aligned squares is empty. */
function freeWay(board: string[], from: number, to: number): boolean {
    const step = Math.sign(to % 8 - from % 8) + 8 * Math.sign(Math.floor(to / 8) - Math.floor(from / 8));
    for (let s = from + step; s !== to; s += step) {
        if (board[s] !== '') return false;
    }
    return true;
}

/** Whether the piece on `from` attacks `to`: the shape of its move, and a free way. A pawn attacks diagonally. */
function attacks(board: string[], from: number, to: number): boolean {
    const files = Math.abs(to % 8 - from % 8), ranks = Math.floor(to / 8) - Math.floor(from / 8);
    if (from === to) return false;
    switch (board[from].toUpperCase()) {
        case 'P': return files === 1 && ranks === (sideOf(board[from]) === 'w' ? 1 : -1);
        case 'N': return files * Math.abs(ranks) === 2;
        case 'K': return files <= 1 && Math.abs(ranks) <= 1;
        case 'B': return files === Math.abs(ranks) && freeWay(board, from, to);
        case 'R': return (files === 0 || ranks === 0) && freeWay(board, from, to);
        case 'Q': return (files === Math.abs(ranks) || files === 0 || ranks === 0) && freeWay(board, from, to);
        default: return false;
    }
}

export function isAttacked(board: string[], target: number, by: Side): boolean {
    return board.some((piece, from) => piece !== '' && sideOf(piece) === by && attacks(board, from, target));
}

export function inCheck(board: string[], side: Side): boolean {
    const king = board.indexOf(side === 'w' ? 'K' : 'k');
    return king >= 0 && isAttacked(board, king, other(side));
}

/**
 * Why a move cannot be played in a position, or undefined if it can. Everything is looked at
 * except whether the move leaves the mover's own king in check.
 */
export function whyNot(position: Position, step: Step): string | undefined {
    const { board, turn } = position;
    const from = squareName(step.from), to = squareName(step.to);
    const piece = board[step.from];
    if (piece === '') return `There is no piece on ${from}.`;
    if (sideOf(piece) !== turn) return `It is ${sideName(turn)}'s turn, and the piece on ${from} is ${sideName(other(turn)).toLowerCase()}.`;
    const kind = piece.toUpperCase();
    const files = Math.abs(step.to % 8 - step.from % 8), ranks = Math.floor(step.to / 8) - Math.floor(step.from / 8);
    if (kind === 'K' && files === 2 && ranks === 0) return whyNotCastle(position, step);       // castling has its own conditions
    const target = board[step.to];
    if (target !== '' && sideOf(target) === turn) return `${sideName(turn)} already has a piece on ${to}.`;

    if (kind === 'P') {
        const forward = turn === 'w' ? 1 : -1;
        const onStart = Math.floor(step.from / 8) === (turn === 'w' ? 1 : 6);
        const advance = files === 0 && target === ''
            && (ranks === forward || (ranks === 2 * forward && onStart && board[step.from + 8 * forward] === ''));
        const capture = files === 1 && ranks === forward && (target !== '' || step.to === position.enPassant);
        if (!advance && !capture) return `A pawn cannot go from ${from} to ${to}.`;
        const lastRank = Math.floor(step.to / 8) === (turn === 'w' ? 7 : 0);
        if (lastRank && !step.promotion) return `A pawn that reaches the last rank is promoted: write ${to}=Q, for a queen.`;
        if (!lastRank && step.promotion) return 'A pawn is promoted only when it reaches the last rank.';
        return undefined;
    }
    if (step.promotion) return `Only a pawn is promoted, and the piece on ${from} is a ${NAMES[kind]}.`;
    if (attacks(board, step.from, step.to)) return undefined;
    const shape = kind === 'N' || kind === 'K' ? false
        : kind === 'B' ? files === Math.abs(ranks)
        : kind === 'R' ? files === 0 || ranks === 0
        : files === Math.abs(ranks) || files === 0 || ranks === 0;
    return shape ? `The way from ${from} to ${to} is not free.` : `A ${NAMES[kind]} cannot go from ${from} to ${to}.`;
}

function whyNotCastle(position: Position, step: Step): string | undefined {
    const { board, turn } = position;
    const home = turn === 'w' ? 4 : 60;
    const kingSide = step.to > step.from;
    const right = turn === 'w' ? (kingSide ? 'K' : 'Q') : (kingSide ? 'k' : 'q');
    if (step.from !== home || !position.castling.includes(right)) {
        return `${sideName(turn)} can no longer castle on this side: the king or the rook has moved.`;
    }
    const between = kingSide ? [home + 1, home + 2] : [home - 1, home - 2, home - 3];
    if (between.some(s => board[s] !== '')) return 'Castling needs empty squares between the king and the rook.';
    if (isAttacked(board, home, other(turn))) return 'Castling is not allowed while the king is in check.';
    const crossed = home + (kingSide ? 1 : -1);
    if (isAttacked(board, crossed, other(turn))) return `The king cannot castle across an attacked square (${squareName(crossed)}).`;
    return undefined;
}

/** The position after a move. The move is not checked here: use `whyNot` first. */
export function play(position: Position, step: Step): Position {
    const board = position.board.slice();
    const turn = position.turn;
    const piece = board[step.from];
    const kind = piece.toUpperCase();
    board[step.from] = '';
    if (kind === 'P' && step.to === position.enPassant) {
        board[step.to + (turn === 'w' ? -8 : 8)] = '';       // en passant: the captured pawn is not on the square reached
    }
    if (kind === 'K' && Math.abs(step.to - step.from) === 2) {
        const kingSide = step.to > step.from;                 // castling: the rook jumps over the king
        const rookFrom = step.from + (kingSide ? 3 : -4), rookTo = step.from + (kingSide ? 1 : -1);
        board[rookTo] = board[rookFrom];
        board[rookFrom] = '';
    }
    board[step.to] = step.promotion ? (turn === 'w' ? step.promotion : step.promotion.toLowerCase()) : piece;

    // A king or a rook that moves, or a rook that is captured at home: that castling is lost.
    const lost: Record<number, string> = { 4: 'KQ', 60: 'kq', 0: 'Q', 7: 'K', 56: 'q', 63: 'k' };
    const gone = (lost[step.from] ?? '') + (lost[step.to] ?? '');
    const castling = position.castling.split('').filter(right => !gone.includes(right)).join('');
    const enPassant = kind === 'P' && Math.abs(step.to - step.from) === 16 ? (step.from + step.to) / 2 : -1;
    return { board, turn: other(turn), castling, enPassant };
}

/** Whether the side to move has at least one legal move (if not: checkmate or stalemate). */
export function hasLegalMove(position: Position): boolean {
    for (let from = 0; from < 64; from++) {
        const piece = position.board[from];
        if (piece === '' || sideOf(piece) !== position.turn) continue;
        for (let to = 0; to < 64; to++) {
            const lastRank = Math.floor(to / 8) === (position.turn === 'w' ? 7 : 0);
            const step: Step = { from, to, promotion: piece.toUpperCase() === 'P' && lastRank ? 'Q' : undefined };
            if (whyNot(position, step) === undefined && !inCheck(play(position, step).board, position.turn)) return true;
        }
    }
    return false;
}
