There are several areas in the `update-status.js` script that can be improved to more accurately collect and report historical data, especially concerning repositories structured with sub-papers, and to address your specific requirements.

Here's a breakdown of issues and how to address them:

**Key Issue: Repo-Level Stats (Commits/Historical) for Repos with Sub-Papers**

The most significant issue is how repository-level statistics like 3-month commit history and weekly commits are handled when a repository contains sub-papers (e.g., in `papers/P1/`, `papers/P2/`).

*   **Current Behavior:** `analyzePaper` calls `analyzeSubpaper` for each sub-directory. `analyzeSubpaper` *does not* call `getHistoricalStats` or `getWeeklyCommits`. If a repo *only* has sub-papers (no root `papers/progress.md`), then `analyzeSinglePaper` (which *does* fetch these stats) is never called for that repository.
*   **Result:** Such repositories will be missing from `this.stats.recentActivity` and their weekly commits won't contribute to `this.stats.weeklyCommits`. Their historical data also won't be properly associated.

**Proposed Solution for Repo-Level Stats:**

1.  **Fetch Repo-Level Stats Once:** In `discoverPapers`, when a repository is identified as a "100SV Repository", fetch its `historicalData` and `weeklyCommitData` *once*.
2.  **Pass Data Down:** Pass this fetched data to `analyzePaper`, and subsequently to `analyzeSinglePaper` or `analyzeSubpaper`.
3.  **Store Consistently:** Both `analyzeSinglePaper` and `analyzeSubpaper` should store this repository-level data (e.g., `paper.historical = historicalData`, `paper.commitsLastWeek = weeklyCommitData.count`). This means every paper item, whether a main paper or a sub-paper, will carry its parent repository's overall stats.
4.  **Aggregate Correctly:** `generateStats` will then sum weekly commits from a central map populated during `discoverPapers`, ensuring each repo is counted once.

**Addressing Specific Historical Data Requirements:**

1.  **3-Month Commit History:**
    *   **Covered:** `getHistoricalStats` correctly fetches this.
    *   **Improvement:** Ensure it's fetched for *all* 100SV repos, including those with only sub-papers, by implementing the refactor above.

2.  **Repository Creation Dates:**
    *   **Covered:** `getHistoricalStats` uses `repo.created_at` to calculate `age`.
    *   **Improvement:** Same as above, ensure availability for all repo types.

3.  **Commit Trends (Active vs. Dormant):**
    *   **Partially Covered:**
        *   `inferStatusFromActivity` (Active, Recent, Inactive, Stale) is a good indicator.
        *   Weekly commits (`commitsLastWeek`) and 3-month commits (`totalCommits3Months`) provide data points.
    *   **No Change Needed (for now):** The script provides data to *infer* trends. Calculating an explicit "trend metric" (e.g., activity increasing/decreasing) would be a more significant feature addition.

4.  **Total Activity (Total Lifetime Commits per Repository):**
    *   **Not Currently Implemented:** The script doesn't fetch total lifetime commits for a repository.
    *   **Proposed Addition:** Modify `getHistoricalStats` to use the `octokit.rest.repos.listContributors` endpoint. Summing the `contributions` field for all (non-bot) contributors gives the total lifetime commits. This is generally more efficient than paginating through all commits.
        *   Store this as `paper.historical.totalLifetimeCommits`.
        *   Report it in `generateDetailedReport`.

**Detailed Code Changes and Suggestions:**

**1. Refactor `ScientificVisionsTracker` Constructor and `discoverPapers`:**

```javascript
class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.owner = process.env.GITHUB_OWNER;
    this.repoFullName = process.env.GITHUB_REPOSITORY;
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [], // Populated with { repo: string, commits: number, lastCommit: string }
      weeklyCommits: 0
    };
    this.repoWeeklyCommitsData = new Map(); // Stores { repoFullName: string, count: number } for all processed 100SV repos

    if (!process.env.GITHUB_TOKEN) {
        console.warn("WARNING: GITHUB_TOKEN environment variable is not set. Octokit will be unauthenticated.");
    }
  }

  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    const targets = [{ type: 'user', name: this.owner }];
    this.papers = [];
    this.stats.recentActivity = []; // Reset recent activity
    this.repoWeeklyCommitsData.clear(); // Reset weekly commits map
    let itemsCount = 0;

    try {
      for (const target of targets) {
        console.log(`DEBUG: Scanning target: ${target.type}/${target.name}`);
        const params = target.type === 'org' ? { org: target.name, type: 'all', per_page: 100 } : { username: target.name, type: 'all', per_page: 100 };
        for await (const { data: page } of this.octokit.paginate.iterator(
          target.type === 'org' ? this.octokit.rest.repos.listForOrg : this.octokit.rest.repos.listForUser, params
        )) {
          for (const repo of page) {
            console.log(`DEBUG: Checking repo from API list: ${repo.full_name}, Private: ${repo.private}, Topics: ${repo.topics?.join(', ')||'None'}`);
            if (this.repoFullName && repo.full_name.toLowerCase() === this.repoFullName.toLowerCase()) {
                console.log(`DEBUG: Skipping self (hub repository): ${repo.full_name}`);
                continue;
            }
            if (await this.is100SVRepository(repo)) {
              console.log(`DEBUG: Repo ${repo.full_name} IS identified as 100SV. Fetching repo-level stats...`);
              
              // Fetch repo-level stats ONCE per repository
              const historicalData = await this.getHistoricalStats(repo);
              const weeklyCommitData = await this.getWeeklyCommits(repo.owner.login, repo.name, repo.private);

              // Store weekly commit data for global aggregation
              if (weeklyCommitData && typeof weeklyCommitData.count === 'number') {
                this.repoWeeklyCommitsData.set(repo.full_name, weeklyCommitData.count);
              }

              // Add to recentActivity if there were commits this week
              if (weeklyCommitData.count > 0) {
                  this.stats.recentActivity.push({ 
                      repo: repo.full_name, 
                      commits: weeklyCommitData.count, 
                      lastCommit: weeklyCommitData.lastMessage 
                  });
              }
              
              console.log(`DEBUG: Analyzing paper structures in ${repo.full_name}...`);
              const paperItems = await this.analyzePaper(repo, historicalData, weeklyCommitData); // Pass fetched data
              
              if (paperItems?.length > 0) {
                this.papers.push(...paperItems);
                itemsCount += paperItems.length;
              }
            }
          }
        }
      }
      console.log(`📊 Found ${itemsCount} paper items.`);
      this.papers.sort((a,b) => (a.fullName||'').localeCompare(b.fullName||''));
      // Sort recentActivity here after all repos are processed
      this.stats.recentActivity.sort((a, b) => b.commits - a.commits);
      this.stats.recentActivity = this.stats.recentActivity.slice(0, 10);

    } catch (e) { console.error(`❌ Error discovering papers: ${e.message}`, e.stack); }
  }

  // ... (is100SVRepository remains the same)
}
```

**2. Modify `getHistoricalStats` to include Total Lifetime Commits:**

```javascript
  async getHistoricalStats(repo) {
    console.log(`DEBUG [${repo.name} (Private: ${repo.private})]: Getting historical stats...`);
    let result = { 
        age: 0, 
        totalCommits3Months: 0, 
        createdAt: repo.created_at,
        totalLifetimeCommits: 0 // Initialize new field
    };
    try {
      const createdAtDate = new Date(repo.created_at);
      result.age = Math.floor((new Date() - createdAtDate) / (1000 * 60 * 60 * 24));
      
      const allowPrivateFetch = true; // Simplified flag
      if (!repo.private || (repo.private && allowPrivateFetch)) {
        // Fetch 3-month commits
        try {
          console.log(`DEBUG [${repo.name}]: Attempting to fetch 3-month commits. Token Auth Set: ${!!this.octokit.authStrategy}`);
          const threeMonthsAgo = new Date(); threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
          for await (const { data: commitPage } of this.octokit.paginate.iterator(
            this.octokit.rest.repos.listCommits, 
            { owner: repo.owner.login, repo: repo.name, since: threeMonthsAgo.toISOString(), per_page: 100 }
          )) { result.totalCommits3Months += commitPage.length; }
          console.log(`DEBUG [${repo.name}]: 3-month commits: ${result.totalCommits3Months}`);
        } catch (e) { 
            console.error(`ERROR fetching 3-month commits for ${repo.name}: ${e.message} (Status: ${e.status})`);
            if (e.status === 401) console.error(`  -> Historical Stats (3m): Auth issue (401). Check PAT scope/validity.`);
            // ... (other specific error messages)
        }

        // Fetch total lifetime commits via contributors
        try {
            console.log(`DEBUG [${repo.name}]: Attempting to fetch total lifetime commits (via contributors).`);
            for await (const { data: contributorsPage } of this.octokit.paginate.iterator(
                this.octokit.rest.repos.listContributors,
                { owner: repo.owner.login, repo: repo.name, anon: "true", per_page: 100 } // anon: "true" includes anonymous
            )) {
                for (const contributor of contributorsPage) {
                    // Optionally exclude bots, though GITHUB_TOKEN actions might appear as bots
                    // if (contributor.type !== "Bot") { 
                        result.totalLifetimeCommits += contributor.contributions;
                    // }
                }
            }
            console.log(`DEBUG [${repo.name}]: Total lifetime commits: ${result.totalLifetimeCommits}`);
        } catch (e) {
            console.error(`ERROR fetching total lifetime commits for ${repo.name}: ${e.message} (Status: ${e.status})`);
            if (e.status === 401) console.error(`  -> Historical Stats (Lifetime): Auth issue (401). Check PAT scope/validity.`);
            // ... (other specific error messages)
        }

      } else {
        console.