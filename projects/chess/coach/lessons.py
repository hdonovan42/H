"""The coaching: for each cause of lost points, what it is, why it happens, the
habit that fixes it, how to drill it, and what "fixed" looks like in the data.

Drills point at Lichess's puzzle themes (free, rated, endless) and at the
player's own positions, which the report turns into puzzles.
"""

LICHESS = "https://lichess.org/training/"

LESSONS = {
    "ignored_threat": {
        "title": "Answer the threat",
        "concept": [
            "Every move does two things: it gives the moved piece new targets, and it takes away whatever that piece "
            "was doing before, including lines it was blocking. So when your opponent moves, the first question is what "
            "their move attacks now, and what it uncovered. That's the threat.",
            "A threat is real when they could carry it out next move and win something: a piece defended too few times, "
            "a check that forks, a mate. Meeting it comes first: move the piece, defend it, block the line, or make a "
            "bigger threat of your own that they have to answer first.",
            "Club players rarely miss threats because they can't see them. They miss them because they didn't look, so "
            "the cure is a fixed routine rather than talent.",
        ],
        "puzzle": "Their last move threatens something. Find the move that deals with it.",
        "refute": True,
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
        "concept": [
            "A square is safe for a piece when the enemy can't take it there for less than it's worth. That's a count: "
            "who attacks the square, who defends it, and what each is worth.",
            "The attackers that get missed are the cheap ones: a pawn that can take a knight, a knight that can take a "
            "rook. Nothing points at the square before you land, so the danger is invisible until you look for it.",
            "Before you let go of a piece, look at its new square from your opponent's side: what could take it there?",
        ],
        "puzzle": "Find the best move.",
        "refute": True,
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
        "concept": [
            "Pieces guard each other. When a piece moves, everything it guarded loses a defender, and anything it was "
            "blocking gets a line through.",
            "The dangerous case is the only defender. What it guarded is now loose, and loose pieces are what double "
            "attacks and simple captures feed on: loose pieces drop off.",
            "Before moving a piece, ask what it's doing where it stands.",
        ],
        "puzzle": "Find the best move.",
        "refute": True,
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
        "concept": [
            "An exchange is a sequence, not a move. Every capture invites a recapture, and the exchange is settled by "
            "who runs out of attackers first and what each side gave up on the way.",
            "Count it before you start: list the attackers and defenders of the square, cheapest first, and play the "
            "captures through to the end. Take only if the final count is in your favour, or if you can see exactly "
            "what you get for the difference.",
        ],
        "puzzle": "Find the best move.",
        "refute": True,
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
        "concept": [
            "Tactics are short forcing sequences (checks, captures, threats) that win because two things can't be "
            "answered at once.",
            "They all need a geometry: two pieces on one line (a pin or a skewer), two pieces a knight's jump from the "
            "same square (a fork), one piece screening another's line (a discovered attack), or a piece with a single "
            "defender doing two jobs (overloading).",
            "The geometry is on the board a move before the tactic lands. Seeing it means looking at your pieces the "
            "way their pieces see them.",
        ],
        "puzzle": "Find the best move.",
        "refute": True,
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
        "concept": [
            "Mate comes when the king runs out of squares. Most club-level mates follow a few patterns: the back rank, "
            "where the king's own pawns wall it in; checks from a queen and rook in tandem; and attacks on a king "
            "whose defenders have wandered off.",
            "Two habits prevent most of them. Give the king an escape square once the position settles (a luft). And "
            "before every move, look at every check your opponent will have after it.",
        ],
        "puzzle": "Find the move that keeps your king safe.",
        "refute": True,
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
        "concept": [
            "Most games at club level are decided by blunders, and a blunder is worth exactly what the other player "
            "collects. A mistake nobody punishes costs nothing.",
            "Winning moves are forcing moves: checks, captures and threats. Scanning those first, every move, is the "
            "quickest way to find them.",
            "The best moment to look is straight after your opponent does something unexpected: surprising moves are "
            "often mistakes.",
        ],
        "puzzle": "There's a winning move here. Find it.",
        "refute": False,
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
        "concept": [
            "A forced mate ends the game whatever else is on the board, so it's worth more than any material. When "
            "the enemy king is short of squares or defenders, checks come first.",
            "Mates are found by pattern more than by calculation: count the king's escape squares, and look for the "
            "check that takes the last one away.",
        ],
        "puzzle": "There's a forced mate. Find the first move.",
        "refute": False,
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
        "concept": [
            "A bad position usually still has a defence, but it's rarely the first move that comes to mind. Often "
            "it's a counter-attack, a check, or an in-between move that changes the order of things.",
            "Under pressure is exactly when to slow down: list every forcing move you have, and work out what they're "
            "threatening before you choose.",
        ],
        "puzzle": "You're under pressure, and one move holds. Find it.",
        "refute": False,
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
        "concept": [
            "When there's no tactic, the game turns on small, lasting things: whose pieces are active, whose pawns are "
            "weak, whose king is safer, who holds the key squares.",
            "Quiet moves aren't free. A pawn move leaves squares behind for good, a retreat takes a piece out of play, "
            "and a trade changes what the position is about.",
            "The simplest plan works: find your worst piece and improve it, and find their weakest point and aim at it.",
        ],
        "puzzle": "No tactic here. Find the move that improves your position.",
        "refute": False,
        "what": "No tactic, but the move made the position clearly worse: a weak pawn move, a passive "
                "piece, a wrong trade.",
        "why": "When nothing is forced, moves get played on autopilot.",
        "fix": [
            "In quiet positions ask: which is my worst piece, and where does it belong? Improve it.",
            "Don't make pawn moves you can't take back without a reason: each one leaves squares behind.",
            "Trade when you're ahead or under attack; keep pieces on when you're attacking.",
        ],
        "drill": [("Quiet move", "quietMove"), ("Endgame", "endgame")],
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
        "title": "Keep time for the end",
        "concept": [
            "The clock is a resource, like material. A 3 + 2 game gives you about six seconds a move over 40 moves, "
            "and every long think is paid for later.",
            "With 20 seconds or less, the clock decides what you can see: there's no time left for a blunder check, "
            "so every habit on this page breaks down at once.",
            "The cure is spending evenly: play what you know quickly, keep long thinks for the critical moments, and "
            "reach the last phase with time in hand.",
        ],
        "puzzle": "You have 20 seconds. Find the best move.",
        "refute": False,
        "target": "Reach move 40 with a minute or more on the clock.",
        "what": "Costly moves made with 20 seconds or less on the clock, counted apart from the habits: at that "
                "speed any habit breaks down, and the fix is the clock, not the chessboard.",
        "fix": [
            "Your opening is already quick; the clock goes in the middlegame. Cap a think at about 20 seconds: "
            "if a position needs more, play the safest move you've found.",
            "Save the long thinks for the moments that decide games: captures, checks, and a surprise from your opponent.",
            "Under a minute, simplify: trade when you're ahead, keep every piece defended, and let the increment carry you.",
            "Under 20 seconds, still check what their last move attacks before you move. Premove only a forced recapture.",
        ],
        "drill": [("Storm, against the clock", "https://lichess.org/storm")],
    },
}


def training_url(slug: str) -> str:
    return slug if slug.startswith("https://") else LICHESS + slug
