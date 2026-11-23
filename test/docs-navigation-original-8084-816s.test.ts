import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const index = read('docs/README.md');
const targets = [
  'PANES.md',
  'NOTIFICATIONS.md',
  'NEEDS-YOU.md',
  'ECOSYSTEM-ONBOARDING.md',
  'DRAFTS.md',
  'OPERATOR-GLANCE.md',
  'AUTOMATIONS-WATCH.md',
  'SELF-UPDATE.md',
  'SHIPPED.md',
  'LANE-HEALTH.md',
  'LANE-HOLDS.md',
  'LANE-FIT.md',
  'PROVIDER-CARDS.md',
  'ZERO-WASTE.md',
  'RESOURCE-LEDGER.md',
  'FLEET-CONFIG.md',
  'FLEET-VERBS.md',
  'COS.md',
  'COS-DESKTOP-API.md',
  'BRIEF-SEND.md',
  'main-guardian.md',
  'MERGE-IDENTITY.md',
  'OUTPUT-EVAL.md',
  'CI-DAILY-PLAN.md',
  'CLOUD-AGENT-ROUTES.md',
  'BRANCH-GARDENER.md',
  'REPO-RANK.md',
  'AMPLIFY.md',
  'BETS-LANE.md',
  'INTENT.md',
  'WORK-ORDERS.md',
  'GRAPH-V1.md',
  'RADAR.md',
  'RELEASE-AUTONOMY.md',
  'AREA-OWNERS.md',
  'CAPABILITY-REGISTRY.md',
  'MCP-TOOLS.md',
  'AGENT-PROFILES.md',
  'AGENT-CHAT.md',
  'APPS-CONTROL.md',
  'APP-DRIVE.md',
  'DESKTOPCTL.md',
  'DESKTOP-OPERATOR.md',
  'SLACK-BUS-INGRESS.md',
  'SLACK-CREDENTIAL-INJECTION.md',
  'AGENT-TO-AGENT.md',
 ];

describe('original 8084 documentation navigation', () => {
  it('links each recovered target once to the public source and a real local document', () => {
    for (const target of targets) {
      const url = `https://github.com/ashlrai/phantom/blob/master/docs/${target}`;
      expect(index.split(url)).toHaveLength(2);
      expect(read(`docs/${target}`).trim().length).toBeGreaterThan(0);
      expect(index).not.toContain(`](${target})`);
    }
  });

  it('makes the operational boundaries discoverable', () => {
    expect(index).toContain('claim and return endpoints and their authorization boundaries');
    expect(index).toContain('unwired Slack Events ingress module');
    expect(index).toContain('approval records a decision and does not send');
    expect(read('docs/CLOUD-AGENT-ROUTES.md')).toContain('Claiming work requires a shell on that host');
    expect(read('docs/SLACK-BUS-INGRESS.md')).toContain('not registered with a listener');
  });
});
