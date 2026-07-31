"""The AI half: turning monitoring facts into something a human wants to read.

The rule that shapes this entire module: **the model writes prose, never facts.**

Every number a reader could act on -- which component, when it started, how long
it lasted, what the monitor said -- is computed from Kuma's data and either
injected into the prompt as a fact or rendered outside the model's text entirely.
The model's job is to say "authentication was unavailable, so signing in failed"
instead of "keycloak: connect ECONNREFUSED". It is a translator, not a source.

That is not fastidiousness. A status page exists to be believed during an
incident, and one hallucinated duration or invented root cause destroys that
permanently. So:

  * the prompt carries a FACTS block and an explicit instruction not to go beyond it
  * output is length-capped and stripped of markdown, because it renders into HTML
  * every LLM call has a deterministic fallback, and the page marks which one it got
  * the model is never asked for severity, timing, or component lists -- those are
    decided in code before it is called
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import httpx

log = logging.getLogger(__name__)

SYSTEM = """You write status-page updates for chat.gsi.de, an internal AI \
assistant used by staff at the GSI research facility.

Audience: colleagues who are not on the operations team. They want to know what \
is broken in terms of what they cannot do, roughly how bad it is, and whether \
anyone is on it.

Rules, in order of importance:
1. Use ONLY the facts given to you. Never invent a cause, a duration, a number, \
or a next step. If the cause is unknown, say it is being investigated.
2. Translate infrastructure into user impact. "Postgres is unreachable" is not \
useful; "conversations cannot be loaded or saved" is.
3. Be calm and specific. No apologies beyond a brief one, no filler, no marketing \
voice, no emoji, no exclamation marks.
4. Plain prose. No markdown, no headings, no bullet points, no links.
5. Never use an em dash or an en dash. Use a comma, a full stop or parentheses \
instead. Hyphens inside ordinary words like "sign-in" are fine.
6. Never speculate about data loss or security. If asked implicitly, say the \
impact is still being assessed."""

#: Names people recognise, for components whose monitor name is infrastructure
#: jargon. Anything not listed is passed through unchanged.
IMPACT = {
    "frontend": "the chat interface",
    "chat": "the chat interface",
    "keycloak": "signing in",
    "auth": "signing in",
    "postgres": "conversation history and search",
    "db": "conversation history and search",
    "database": "conversation history and search",
    "valkey": "staying signed in",
    "redis": "staying signed in",
    "s3": "file uploads and downloads",
    "seaweed": "file uploads and downloads",
    "storage": "file uploads and downloads",
    "grafana": "internal dashboards",
    "prometheus": "internal monitoring",
    "loki": "internal log search",
    "llm": "generating answers",
    "proxy": "generating answers",
}


def user_impact(component: str) -> str:
    key = component.lower()
    for needle, impact in IMPACT.items():
        if needle in key:
            return impact
    return component


class Writer:
    """Calls the GSI LLM proxy. Degrades to templates when it cannot."""

    def __init__(self, base_url: str, api_key: str, model: str, enabled: bool = True,
                 timeout: float = 45.0):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.enabled = enabled and bool(api_key)
        self.timeout = timeout
        self._failures = 0

    @property
    def available(self) -> bool:
        # After repeated failures stop trying for a while: during a real outage
        # the proxy may be exactly what is broken, and an agent that blocks 45
        # seconds per attempt stops publishing updates when they matter most.
        return self.enabled and self._failures < 5

    def _complete(self, prompt: str, max_tokens: int = 900) -> str | None:
        if not self.available:
            return None
        try:
            resp = httpx.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}",
                         "Content-Type": "application/json",
                         # The proxy mislabels Content-Encoding; see crawler/app/llm.py.
                         "Accept-Encoding": "identity"},
                json={"model": self.model,
                      "messages": [{"role": "system", "content": SYSTEM},
                                   {"role": "user", "content": prompt}],
                      "max_tokens": max_tokens, "temperature": 0.3},
                timeout=self.timeout,
            )
            resp.raise_for_status()
            message = resp.json()["choices"][0]["message"]
            # Reasoning models answer with content=null when the token budget went
            # entirely on reasoning, and some proxies then put the visible answer
            # in reasoning_content instead. Both are normal, neither is an
            # exception -- treating them as one made every short update fall back
            # to the template while the long ones worked.
            text = message.get("content") or message.get("reasoning_content") or ""
            text = _clean(text)
            if not text:
                self._failures += 1
                log.info("status writer got an empty completion (%d)", self._failures)
                return None
            self._failures = 0
            return text
        except Exception as exc:  # noqa: BLE001
            self._failures += 1
            log.warning("status writer LLM call failed (%d): %s", self._failures, exc)
            return None

    # --- the three things it writes -------------------------------------------

    def incident_opened(self, facts: dict[str, Any]) -> tuple[str, str, bool]:
        """(title, body, ai_written) for a newly detected incident."""
        components = facts["components"]
        impacts = sorted({user_impact(c) for c in components})

        prompt = (
            "A monitoring check has just started failing. Write a status-page entry.\n\n"
            f"FACTS (do not go beyond these):\n{_facts_block(facts)}\n\n"
            "Reply as JSON with exactly two string fields:\n"
            '  "title": under 70 characters, naming what is affected in user terms\n'
            '  "body": 2-3 sentences: what users will notice, what is known, '
            'and that it is being investigated.\n'
            "No markdown. No other fields."
        )
        raw = self._complete(prompt)
        if raw:
            parsed = _json_object(raw)
            title = _trim(parsed.get("title", ""), 90)
            body = _trim(parsed.get("body", ""), 600)
            if title and body:
                return title, body, True

        # Deterministic fallback. Deliberately plain -- it must read as a
        # deliberate message, not as a broken template.
        what = _join(impacts)
        title = _trim(f"Degraded: {what}", 90)
        body = (f"Monitoring detected that {what} became unavailable at "
                f"{facts['started_at']}. The cause is being investigated. "
                f"Affected checks: {_join(components)}.")
        return title, body, False

    def degradation_opened(self, facts: dict[str, Any]) -> tuple[str, str, bool]:
        """
        (title, body, ai_written) for a component that is slow but still working.

        The distinction from an outage has to survive into the wording, because
        the reader's decision differs: during degradation their work still goes
        through and they mostly need to know why it feels sluggish.
        """
        components = facts["components"]
        impacts = sorted({user_impact(c) for c in components})

        prompt = (
            "A component is responding much more slowly than usual, but it is "
            "still working. Write a status-page entry about DEGRADED PERFORMANCE, "
            "not an outage.\n\n"
            f"FACTS (do not go beyond these):\n{_facts_block(facts)}\n\n"
            "Reply as JSON with exactly two string fields:\n"
            '  "title": under 70 characters, saying what is slow in user terms\n'
            '  "body": 2-3 sentences: that the service still works but is slower '
            'than normal, what users will notice, and that it is being looked at.\n'
            "Do not say anything is down, unavailable or offline -- it is not.\n"
            "No markdown. No other fields."
        )
        raw = self._complete(prompt, max_tokens=700)
        if raw:
            parsed = _json_object(raw)
            title = _trim(parsed.get("title", ""), 90)
            body = _trim(parsed.get("body", ""), 600)
            if title and body:
                return title, body, True

        what = _join(impacts)
        title = _trim(f"Slow responses: {what}", 90)
        body = (f"{what.capitalize()} is responding more slowly than usual but is "
                f"still working. This has been the case for {facts.get('duration', 'a few minutes')}. "
                f"The cause is being looked into.")
        return title, body, False

    def maintenance_opened(self, facts: dict[str, Any]) -> tuple[str, str, bool]:
        """
        (title, body, ai_written) for downtime that Kubernetes says is deliberate.

        The model is given the workload and the reason and decides how to put it.
        It is also explicitly allowed to disagree: if what it is shown does not
        look like planned work, it should say the service is unavailable and let
        the deterministic fallback wording stand rather than inventing a
        maintenance window nobody scheduled.
        """
        components = facts["components"]
        impacts = sorted({user_impact(c) for c in components})

        prompt = (
            "A component is not responding, AND the Kubernetes API reports that "
            "its workload is currently being changed -- a deployment, a restart, "
            "or an image being pulled. This is almost certainly planned work "
            "rather than a fault. Write a status-page entry about MAINTENANCE.\n\n"
            f"FACTS (do not go beyond these):\n{_facts_block(facts)}\n\n"
            "Reply as JSON with exactly two string fields:\n"
            '  "title": under 70 characters, naming what is briefly unavailable\n'
            '  "body": 2-3 sentences: that the component is being updated, what '
            'users cannot do meanwhile, and that it should return shortly.\n'
            "Do not invent a schedule, a maintenance window, an end time or a "
            "reason for the change -- you have not been told any of those.\n"
            "No markdown. No other fields."
        )
        raw = self._complete(prompt, max_tokens=700)
        if raw:
            parsed = _json_object(raw)
            title = _trim(parsed.get("title", ""), 90)
            body = _trim(parsed.get("body", ""), 600)
            if title and body:
                return title, body, True

        what = _join(impacts)
        title = _trim(f"Maintenance: {what}", 90)
        body = (f"{what.capitalize()} is briefly unavailable while it is being "
                f"updated ({facts.get('rollout', 'deployment in progress')}). "
                f"It should return on its own shortly.")
        return title, body, False

    def incident_escalated(self, facts: dict[str, Any]) -> tuple[str, bool]:
        prompt = (
            "An ongoing incident has spread to more components. Write ONE short "
            "paragraph (2 sentences) as the next update.\n\n"
            f"FACTS (do not go beyond these):\n{_facts_block(facts)}\n\n"
            "Plain prose only. No markdown, no JSON, no title."
        )
        body = self._complete(prompt, max_tokens=700)
        if body:
            return _trim(body, 600), True
        newly = _join(sorted({user_impact(c) for c in facts.get("new_components", [])}))
        return (f"The incident now also affects {newly}. Investigation continues.", False)

    def incident_resolved(self, facts: dict[str, Any]) -> tuple[str, bool]:
        prompt = (
            "The failing checks have recovered and stayed healthy. Write the "
            "resolution update: ONE short paragraph (2-3 sentences) confirming "
            "service is restored, how long it lasted, and what users should do if "
            "they still see problems (reload the page, and report it if it "
            "persists).\n\n"
            f"FACTS (do not go beyond these):\n{_facts_block(facts)}\n\n"
            "Plain prose only. No markdown, no JSON, no title."
        )
        body = self._complete(prompt, max_tokens=800)
        if body:
            return _trim(body, 700), True
        what = _join(sorted({user_impact(c) for c in facts["components"]}))
        mins = facts.get("duration_minutes")
        lasted = f" The disruption lasted about {mins} minutes." if mins else ""
        return (f"All checks are passing again and {what} is working normally."
                f"{lasted} If you still see problems, reload the page; if it "
                f"persists, please report it.", False)

    def all_clear(self, facts: dict[str, Any]) -> tuple[str, bool]:
        """The 'all systems operational' note published after everything recovers."""
        prompt = (
            "Every monitored component is healthy again after a period of "
            "disruption. Write ONE sentence confirming all systems are "
            "operational.\n\n"
            f"FACTS (do not go beyond these):\n{_facts_block(facts)}\n\n"
            "Plain prose only. No markdown, no JSON."
        )
        body = self._complete(prompt, max_tokens=600)
        if body:
            return _trim(body, 300), True
        return ("All systems are operational. Every monitored component is "
                "reporting healthy.", False)


# --- helpers -----------------------------------------------------------------

def _facts_block(facts: dict[str, Any]) -> str:
    lines = []
    for key, value in facts.items():
        if value is None or value == [] or value == "":
            continue
        if isinstance(value, (list, tuple)):
            value = ", ".join(str(v) for v in value)
        lines.append(f"- {key.replace('_', ' ')}: {value}")
    return "\n".join(lines)


def _clean(text: Any) -> str:
    """Strip the markdown and punctuation the model was told not to produce.

    Instructions are a request, not a guarantee, and this renders into HTML --
    so leftover ** and ### would show up literally on the page.

    Em and en dashes are rewritten here rather than only asked for in the system
    prompt, for the same reason: the rule holds even when the model ignores it.
    Runs before the JSON is parsed, so it covers the title and body alike.
    """
    if not text:
        return ""
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", str(text).strip())
    text = re.sub(r"\*\*|__|^#+\s*", "", text, flags=re.MULTILINE)
    # A comma reads correctly wherever the model would have put a dash between
    # clauses, and in a list ("components - Chat interface, ...") it is what the
    # sentence wanted anyway. Ordinary hyphens are left alone.
    text = re.sub(r"\s*[‒–—―]+\s*", ", ", text)
    text = re.sub(r",\s*,+", ",", text)
    return text.strip()


def _json_object(raw: str) -> dict[str, Any]:
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start != -1 and end > start:
            try:
                return json.loads(raw[start:end + 1])
            except json.JSONDecodeError:
                pass
    return {}


def _trim(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    # Cut at a sentence end where possible; a status update ending mid-word
    # reads as a bug in the status page.
    cut = text[:limit]
    stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return (cut[:stop + 1] if stop > limit * 0.5 else cut.rstrip()) .strip()


def _join(items: list[str]) -> str:
    items = [i for i in items if i]
    if not items:
        return "the service"
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]
