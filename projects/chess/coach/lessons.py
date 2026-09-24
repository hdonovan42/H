"""The coaching: for each cause of lost points, what it is, why it happens, the
habit that fixes it, how to drill it, and what "fixed" looks like in the data.

Drills point at Lichess's puzzle themes (free, rated, endless) and at the
player's own positions, which the report turns into puzzles.
"""

LICHESS = "https://lichess.org/training/"

LESSONS = {
    "ignored_threat": {
        "title": "Answer the threat",
        "what": "Your opponent's last move attacked something, and your reply didn't deal with it.",
        "why": "You were following your own plan. At club level this is the commonest way to lose "
               "material: not missing a clever trick, just not asking what the last move changed.",
        "fix": [
            "Before every move, ask one question about your opponent's move: what does it attack now?",
            "Check every square the moved piece hits, and any line it opened by moving.",
            "If something of yours is newly attacked, answer it first: move it, defend it, or make a "
            "bigger threat (a check, a capture of something worth more).",
        ],
        "drill": [("Hanging piece", "hangingPiece"), ("Defensive move", "defensiveMove")],
        "target": "Ignored threats in under one game in ten.",
    },
    "moved_into_attack": {
        "title": "Check the square before you land",
        "what": "You moved a piece to a square where it could simply be taken.",
        "why": "The move looked active, and you checked where the piece was going to attack, not what "
               "attacks the square it was going to.",
        "fix": [
            "Before you let go of a piece, count what attacks its new square and what defends it.",
            "Land only where your defenders at least match their attackers, and never where something "
            "cheaper can take it (a pawn taking a knight, a knight taking a rook).",
            "Pawns first: the most common attacker you'll miss is a pawn that can simply take.",
        ],
        "drill": [("Hanging piece", "hangingPiece"), ("Trapped piece", "trappedPiece")],
        "target": "No piece dropped on a guarded square for a week of games.",
    },
    "left_undefended": {
        "title": "Know what a piece was guarding",
        "what": "Your move took away the protection another piece relied on, or opened a line to it.",
        "why": "Pieces do two jobs at once. Moving one to do something new quietly cancels the old job.",
        "fix": [
            "Before moving a piece, ask what it defends right now.",
            "Ask what line opens behind it: moving it can uncover an attack on the piece it screened.",
            "If it's the only defender of something, either don't move it or defend that piece first.",
        ],
        "drill": [("Capturing the defender", "capturingDefender"), ("Deflection", "deflection")],
        "target": "Leaving pieces unguarded in under one game in ten.",
    },
    "traded_down": {
        "title": "Count the whole exchange",
        "what": "You captured, and the exchange that followed left you with less than you started.",
        "why": "The first capture looks free; the recaptures come after the moment you stopped counting.",
        "fix": [
            "Before capturing, list who attacks and who defends that square, cheapest first.",
            "Play the captures out in your head to the end. Take only if you come out ahead.",
            "A capture that loses the exchange is fine only when you've seen what you get for it.",
        ],
        "drill": [("Hanging piece", "hangingPiece"), ("Advantage", "advantage")],
        "target": "Losing exchanges you start: close to none.",
    },
    "allowed_tactic": {
        "title": "See the fork, pin or skewer coming",
        "what": "Your move walked into a fork, pin, skewer or discovered attack.",
        "why": "These tactics need your pieces in a particular geometry, and that geometry is visible "
               "a move before the tactic lands, if you look for it.",
        "fix": [
            "Lines: are your king or queen on the same file, rank or diagonal as another of your pieces, "
            "with an enemy bishop, rook or queen able to reach that line? That's a pin or skewer waiting.",
            "Knight squares: are two of your valuable pieces (or king and a piece) a knight's jump from one "
            "square an enemy knight can reach? That's a fork waiting.",
            "Undefended pieces are the ones double attacks win: keep your pieces protected (LPDO: loose "
            "pieces drop off).",
        ],
        "drill": [("Fork", "fork"), ("Pin", "pin"), ("Skewer", "skewer"), ("Discovered attack", "discoveredAttack")],
        "target": "Tactics allowed: under one game in ten.",
    },
    "allowed_mate": {
        "title": "Guard your king against mate",
        "what": "Your move allowed a forced checkmate.",
        "why": "Mates land where the king has no escape squares, usually a back rank shut in by its own "
               "pawns, or a king stripped of defenders while your pieces are elsewhere.",
        "fix": [
            "Give the king air once the position settles: a pawn move like h3 (h6 as Black) ends back-rank "
            "mates for good.",
            "Before every move, look at the checks your opponent will have after it, and at what each one "
            "does to your king.",
            "Don't pull your last defenders away from the king to chase material.",
        ],
        "drill": [("Back-rank mate", "backRankMate"), ("Mate in 1", "mateIn1"), ("Mate in 2", "mateIn2")],
        "target": "Mates allowed: none.",
    },
    "missed_win": {
        "title": "Punish mistakes: checks, captures, threats",
        "what": "A winning tactic or a free piece was on the board, and you played something else.",
        "why": "At this level most games are decided by who spots the other's blunder. Missing one is as "
               "costly as making one.",
        "fix": [
            "Every move, before your own plan, scan for yourself: every check, every capture, every "
            "threat you could make (CCT). It takes a second or two.",
            "Start with captures: is anything of theirs undefended, or defended fewer times than you attack it?",
            "When their last move was a surprise, assume it's a mistake until you've checked what it left behind.",
        ],
        "drill": [("Hanging piece", "hangingPiece"), ("Fork", "fork"), ("Advantage", "advantage")],
        "target": "Punish at least three in four of your opponent's blunders.",
    },
    "missed_mate": {
        "title": "Look for mate first",
        "what": "You had a forced mate and played something else.",
        "why": "Winning material feels safe, so the eye goes to captures before checks.",
        "fix": [
            "When the enemy king is short of defenders or squares, look at every check before anything else.",
            "Count the king's escape squares after each check: when there are none, it's mate.",
            "Learn the patterns so they're recognised, not calculated: back rank, smothered, queen and rook ladders.",
        ],
        "drill": [("Mate in 1", "mateIn1"), ("Mate in 2", "mateIn2"), ("Mate in 3", "mateIn3")],
        "target": "Mates in one or two: never missed.",
    },
    "missed_defence": {
        "title": "Find the only move",
        "what": "You were in trouble, one move held the position, and you played something else.",
        "why": "Under pressure the eye goes to the obvious defence or to hoping. Positions like these usually "
               "have one resource: a counter-attack, a check, an in-between move.",
        "fix": [
            "When the position feels critical, stop and list every forcing move you have: checks, captures, threats.",
            "Ask what your opponent is actually threatening, then look for the move that meets it and does something too.",
            "Don't settle for the first defence that comes to mind; compare it with at least one other.",
        ],
        "drill": [("Defensive move", "defensiveMove"), ("Intermezzo", "intermezzo")],
        "target": "Find the only move more often than not.",
    },
    "positional": {
        "title": "Plans, not just moves",
        "what": "No tactic, but the move made the position clearly worse: a weak pawn move, a passive "
                "piece, a wrong trade.",
        "why": "When nothing is forced, moves get played on autopilot.",
        "fix": [
            "In quiet positions ask: which is my worst piece, and where does it belong? Improve it.",
            "Don't make pawn moves you can't take back without a reason: each one leaves squares behind.",
            "Trade when you're ahead or under attack; keep pieces on when you're attacking.",
        ],
        "drill": [("Advantage", "advantage"), ("Endgame", "endgame")],
        "target": "Fewer mistakes with no tactic behind them.",
    },
}

# Positional mistakes aren't one habit: advice for each kind the tagger finds
FEATURES = {
    "an attack on your king": "Their pieces got at your king. Count attackers against defenders around it, keep a "
                              "piece near it, and don't open lines towards it.",
    "a pawn in front of your king": "Pawns in front of a castled king are its walls. Push them only when you're attacking "
                                    "with them, never to chase a piece.",
    "a king walk with queens on": "With queens on, the king belongs behind pawns. Bring it out when the queens come off.",
    "endgame technique": "Endgames reward activity: centralise the king, push passed pawns, rooks behind them. "
                         "When ahead, trade pieces and keep the pawns.",
    "opening play": "Develop knights and bishops, castle, and fight for the centre before anything else. Don't move "
                    "a piece twice or bring the queen out early without a reason.",
    "a middlegame plan": "In quiet positions, improve your worst piece and aim at a target (a weak pawn, a square, "
                         "their king) rather than making waiting moves.",
}

# Game-level lessons, attached to the time and conversion pictures
GAME_LESSONS = {
    "conversion": {
        "title": "Finish the job",
        "what": "You reached a winning position and didn't win the game.",
        "fix": [
            "When you're ahead, trade pieces, not pawns: fewer pieces means fewer tricks against you.",
            "Take away counterplay before pushing for more: secure your king, cover their checks.",
            "In blitz, simplify to a win that needs little time rather than the fastest win.",
        ],
        "drill": [("Crushing", "crushing"), ("Endgame", "endgame")],
    },
    "time": {
        "title": "Spend time where it matters",
        "what": "How your mistakes move with the clock.",
        "fix": [
            "Play the opening you know quickly and bank the time for the middlegame.",
            "Slow down at the critical moments: captures, checks, and when your opponent does something unexpected.",
            "Under 10% of your time, play safe moves: keep pieces defended rather than calculating long lines.",
        ],
        "drill": [],
    },
}


def training_url(slug: str) -> str:
    return LICHESS + slug
