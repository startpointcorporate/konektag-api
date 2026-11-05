import unittest
from konektag_meetings.appointment import choose_agent


class AssignmentTests(unittest.TestCase):
    def setUp(self):
        self.allowed = ["charcel@example.test", "simon@example.test"]

    def test_keeps_existing_owner_when_free(self):
        self.assertEqual(
            choose_agent(self.allowed[0], self.allowed, [], list(reversed(self.allowed))),
            self.allowed[0],
        )

    def test_reassigns_when_existing_owner_busy(self):
        self.assertEqual(
            choose_agent(self.allowed[0], self.allowed, [self.allowed[0]], self.allowed),
            self.allowed[1],
        )

    def test_rejects_outside_opportunity_owner(self):
        self.assertEqual(
            choose_agent("outside@example.test", self.allowed, [], self.allowed),
            self.allowed[0],
        )

    def test_refuses_when_all_agents_busy(self):
        self.assertIsNone(choose_agent(self.allowed[0], self.allowed, self.allowed, self.allowed))

    def test_single_agent_sites(self):
        self.assertEqual(choose_agent(None, [self.allowed[1]], [], [self.allowed[1]]), self.allowed[1])
