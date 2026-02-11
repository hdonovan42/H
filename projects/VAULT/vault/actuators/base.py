"""Base actuator ABC — all actuators inherit from this."""

from abc import ABC, abstractmethod


class BaseActuator(ABC):
    """Base class for VAULT actuators (tools)."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Tool name for Claude tool_use."""

    @property
    @abstractmethod
    def description(self) -> str:
        """Tool description shown to Claude."""

    @property
    @abstractmethod
    def parameters(self) -> dict:
        """JSON Schema for tool parameters."""

    @property
    def terminal(self) -> bool:
        """If True, this action ends the cycle. If False, Claude can continue."""
        return True

    @abstractmethod
    def execute(self, conn, params: dict, context: dict) -> dict:
        """Execute the actuator. Returns result dict for tool_result.

        Args:
            conn: SQLite connection
            params: Parsed tool input from Claude
            context: Cycle context (cycle_id, prices, balance, etc.)
        """

    def to_tool_schema(self) -> dict:
        """Convert to Anthropic tool schema format."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.parameters,
        }
