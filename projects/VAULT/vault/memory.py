"""Strategy memory — agent's persistent notes to future self."""

import logging

log = logging.getLogger("vault.memory")


def write_memory(conn, category: str, content: str, relevance: float = 1.0) -> int:
    """Write a memory entry. Returns memory ID."""
    cur = conn.execute(
        "INSERT INTO memory (category, content, relevance) VALUES (?, ?, ?)",
        (category, content, min(max(relevance, 0.0), 1.0)),
    )
    conn.commit()
    log.info(f"Memory written [{category}]: {content[:80]}...")
    return cur.lastrowid


def get_memories(conn, limit: int = 20, category: str | None = None) -> list[dict]:
    """Get active memories, ordered by relevance then recency."""
    query = "SELECT id, category, content, relevance, ts FROM memory WHERE active = 1"
    params = []

    if category:
        query += " AND category = ?"
        params.append(category)

    query += " ORDER BY relevance DESC, ts DESC LIMIT ?"
    params.append(limit)

    rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def format_memories_for_prompt(conn, max_tokens_approx: int = 500) -> str:
    """Format memories for system prompt injection. Token-efficient."""
    memories = get_memories(conn, limit=15)
    if not memories:
        return "No strategy memories yet."

    lines = []
    char_budget = max_tokens_approx * 4  # rough chars-to-tokens
    used = 0

    for m in memories:
        line = f"[{m['category']}] {m['content']}"
        if used + len(line) > char_budget:
            break
        lines.append(line)
        used += len(line)

    return "\n".join(lines)


def deactivate_memory(conn, memory_id: int):
    """Mark a memory as inactive."""
    conn.execute("UPDATE memory SET active = 0 WHERE id = ?", (memory_id,))
    conn.commit()
