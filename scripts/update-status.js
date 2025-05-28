const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN // This should be your PAT via workflow secrets
    });
    this.owner = process.env.GITHUB_OWNER;
    this.repoFullName = process.env.GITHUB_REPOSITORY;
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [], // Populated with { repoFullName: string, commits: number, lastCommit: string }
      weeklyCommits: 0
    };
    // Stores { repoFullName: string, count: number } for all processed 100SV repos
    this.repoWeeklyCommitsData = new Map(); 

    // Verify token presence during construction for early feedback
    if (!process.env.GITHUB_TOKEN) {
        console.warn("WARNING: GITHUB_TOKEN environment variable is not set. Octokit will be unauthenticated.");
    } else {
        // console.log("DEBUG: Octokit initialized with GITHUB_TOKEN environment variable.");
    }
  }

  async parseFileContent(owner, repoName, filePath) {
    // console.log(`DEBUG: Attempting to read: ${owner}/${repoName}/${filePath}`);
    try {
      const { data: file } = await this.octokit.rest.repos.getContent({
        owner, repo: repoName, path: filePath, request: { retries: 0 }
      });
      if (file.content) {
        // console.log(`DEBUG: Content FOUND for ${filePath} in ${owner}/${repoName}`);
        return Buffer.from(file.content, 'base64').toString();
      }
      // console.log(`DEBUG: File ${filePath} in ${owner}/${repoName} has NO content field.`);
    } catch (error) { 
        // console.log(`DEBUG: File NOT FOUND or error reading ${owner}/${repoName}/${filePath}: ${error.message} (Status: ${error.status})`);
    }
    return null;
  }

  parseProgress(content) {
    const progress = {
      title: null, status: null, priority: null, phase: [], preprintLink: null, publishedLink: null
    };
    const extractValue = (label, fieldName) => {
        const regex = new RegExp(`^\\*\\*${label}\\*\\*:\\s*(?:\\[([^\\]\\r\\n]*?)\\]|([^\\r\\n]*?))\\s*(?:\\r?\\n|$)`, "im");
        const match = content.match(regex);
        if (match) {
            const value = (match[1] !== undefined ? match[1] : match[2] || "").trim();
            return value;
        }
        return null;
    };
    progress.title = extractValue("Paper Title", "Paper Title");
    progress.status = extractValue("Status", "Status");
    progress.priority = extractValue("Priority", "Priority");
    const preprintRegex = /^\*\*Preprint\*\*:\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s]+))\s*$/im;
    const preprintMatch = content.match(preprintRegex);
    if (preprintMatch) {
        const url = (preprintMatch[1] || preprintMatch[2] || '').trim();
        if (url && !url.toLowerCase().startsWith('[link')) progress.preprintLink = url;
    }
    const publishedRegex = /^\*\*Published\*\*:\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s]+))\s*$/im;
    const publishedMatch = content.match(publishedRegex);
    if (publishedMatch) {
        const url = (publishedMatch[1] || publishedMatch[2] || '').trim();
        if (url && !url.toLowerCase().startsWith('[doi')) progress.publishedLink = url;
    }
    const phaseMatches = content.match(/- \[x\]\s*([^\r\n]+)/gim);
    if (phaseMatches) progress.phase = phaseMatches.map(m => m.replace(/- \[x\]\s*/i, '').trim());
    return progress;
  }
  
  parse100SV(content) {
    const svData = { projectId: null, researchArea: null, researchFocus: null };
    const extract = (lbl) => {
        const r = new RegExp(`^\\*\\*${lbl}\\*\\*:\\s*(?:\\[([^\\]\\r\\n]*?)\\]|([^\\r\\n]*?))(?:\r?\n|$)`, "im");
        const m = content.match(r);
        if(m) return (m[1]!==undefined?m[1]:m[2]||"").trim(); return null;
    };
    svData.projectId = extract("Project ID");
    svData.researchArea = extract("Research Area");
    const focusMatch = content.match(/^## Research Focus\s*\n+([\s\S]*?)(?=\n##|\n---|\n\*{3,}|$)/im);
    if (focusMatch && focusMatch[1]) svData.researchFocus = focusMatch[1].trim(); 
    return svData;
  }

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
      
      const allowPrivateFetch = true; // Allow fetching for private repos if PAT has access
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
            if (e.status === 401) console.error(`  -> Historical Stats (3m): Auth issue (401). Check PAT scope/validity for ${repo.full_name}.`);
            else if (e.status === 403) console.error(`  -> Historical Stats (3m): Permission issue (403) for ${repo.full_name}. Verify PAT access.`);
            else if (e.status === 404) console.error(`  -> Historical Stats (3m): Repo ${repo.full_name} not found (404) with current token.`);
        }

        // Fetch total lifetime commits via contributors
        try {
            console.log(`DEBUG [${repo.name}]: Attempting to fetch total lifetime commits (via contributors).`);
            for await (const { data: contributorsPage } of this.octokit.paginate.iterator(
                this.octokit.rest.repos.listContributors,
                { owner: repo.owner.login, repo: repo.name, anon: "true", per_page: 100 } // anon: "true" includes anonymous
            )) {
                for (const contributor of contributorsPage) {
                    result.totalLifetimeCommits += (contributor.contributions || 0);
                }
            }
            console.log(`DEBUG [${repo.name}]: Total lifetime commits: ${result.totalLifetimeCommits}`);
        } catch (e) {
            console.error(`ERROR fetching total lifetime commits for ${repo.name}: ${e.message} (Status: ${e.status})`);
            if (e.status === 401) console.error(`  -> Historical Stats (Lifetime): Auth issue (401). Check PAT scope/validity for ${repo.full_name}.`);
            else if (e.status === 403) console.error(`  -> Historical Stats (Lifetime): Permission issue (403) for ${repo.full_name}. Verify PAT access.`);
            else if (e.status === 404) console.error(`  -> Historical Stats (Lifetime): Repo ${repo.full_name} not found (404) with current token.`);
        }
      } else {
        console.log(`DEBUG [${repo.name}]: Skipping historical commit history (private repo / fetch disabled by logic -- should not happen with allowPrivateFetch=true).`);
      }
    } catch (e) { console.error(`Error in getHistoricalStats (outer) for ${repo.name}: ${e.message}`); }
    return result;
  }

  async getWeeklyCommits(repoOwner, repoName, isPrivate) {
    console.log(`DEBUG [${repoName} (Private: ${isPrivate})]: Getting weekly commits...`);
    let count = 0, lastMessage = null;
    if (!repoOwner || !repoName) return { count, lastMessage };
    
    const allowPrivateFetch_Weekly = true; 
    if (!isPrivate || (isPrivate && allowPrivateFetch_Weekly)) {
        try {
            console.log(`DEBUG [${repoName}]: Attempting to fetch weekly commits. Token Auth Set: ${!!this.octokit.authStrategy}`);
            const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
            for await (const { data: page } of this.octokit.paginate.iterator(
                this.octokit.rest.repos.listCommits,
                { owner: repoOwner, repo: repoName, since: weekAgo.toISOString(), per_page: 100 }
            )) {
                if (page.length > 0 && !lastMessage && page[0].commit) lastMessage = page[0].commit.message.split('\n')[0];
                count += page.length;
            }
            console.log(`DEBUG [${repoName}]: Weekly commits: ${count}, Last msg: ${lastMessage ? lastMessage.substring(0,30)+'...' : 'N/A'}`);
        } catch (e) { 
            console.error(`ERROR fetching weekly commits for ${repoName}: ${e.message} (Status: ${e.status})`);
            if (e.status === 401) console.error(`  -> Weekly Commits: Auth issue (401). Check PAT scope/validity for ${repoOwner}/${repoName}.`);
            else if (e.status === 403) console.error(`  -> Weekly Commits: Permission issue (403) for ${repoOwner}/${repoName}. Verify PAT access.`);
            else if (e.status === 404) console.error(`  -> Weekly Commits: Repo ${repoOwner}/${repoName} not found (404) with current token.`);
        }
    } else {
        console.log(`DEBUG [${repoName}]: Skipping weekly commit history (private repo / fetch disabled by logic -- should not happen with allowPrivateFetch_Weekly=true).`);
    }
    return { count, lastMessage };
  }

  async analyzeSinglePaper(repo, historicalData, weeklyCommitData) {
    console.log(`DEBUG: Analyzing single paper: ${repo.full_name}`);
    const paper = {
      repoName: repo.name, paperName: repo.name, fullName: repo.full_name,
      description: repo.description || 'No repository description.',
      url: repo.html_url, repoUrl: repo.html_url, private: repo.private,
      topics: repo.topics || [], lastUpdated: repo.updated_at, title: null,
      status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      commitsLastWeek: 0, 
      historical: { age: 0, totalCommits3Months: 0, createdAt: repo.created_at, totalLifetimeCommits: 0 },
      preprintLink: null, publishedLink: null, isSubpaper: false,
      projectId: null, researchArea: null,
    };

    paper.historical = historicalData;
    paper.commitsLastWeek = weeklyCommitData.count;

    const svContent = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
    if (svContent) {
        const sv = this.parse100SV(svContent);
        if (sv.researchFocus) paper.description = sv.researchFocus;
        paper.projectId = sv.projectId; paper.researchArea = sv.researchArea;
    }

    let t = null, s = null, pVal = null;
    const progressMd = await this.parseFileContent(repo.owner.login, repo.name, 'papers/progress.md');
    if (progressMd) {
      const prog = this.parseProgress(progressMd);
      paper.progress = prog; 
      if (prog.title) t = prog.title; if (prog.status) s = prog.status;
      if (prog.priority) pVal = prog.priority;
      paper.preprintLink = prog.preprintLink; paper.publishedLink = prog.publishedLink;
    }

    if (t) { paper.title = t; paper.paperName = t; }
    const statusFromProgress = s;
    paper.status = s || (await this.inferStatusFromActivity(repo, 'papers/'));
    paper.priority = pVal || 'Medium';
    console.log(`DEBUG [${paper.fullName}]: Title='${paper.title}', Status(prog)='${statusFromProgress}', FinalStatus='${paper.status}', Prio='${paper.priority}'`);
    
    return paper;
  }

  async analyzeSubpaper(repo, subpaperDir, historicalData, weeklyCommitData) {
    console.log(`DEBUG: Analyzing sub-paper: ${repo.full_name}/${subpaperDir}`);
    const paper = {
      repoName: repo.name, paperName: subpaperDir, fullName: `${repo.full_name}/${subpaperDir}`,
      description: repo.description || 'No repository description.',
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`, repoUrl: repo.html_url,
      private: repo.private, topics: repo.topics || [], lastUpdated: repo.updated_at,
      title: null, status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      commitsLastWeek: 0,
      historical: { age: 0, totalCommits3Months: 0, createdAt: repo.created_at, totalLifetimeCommits: 0 },
      preprintLink: null, publishedLink: null, isSubpaper: true,
      projectId: null, researchArea: null
    };

    paper.historical = historicalData;
    paper.commitsLastWeek = weeklyCommitData.count;

    const svSub = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/100SV.md`);
    if (svSub) {
        const sv = this.parse100SV(svSub);
        if (sv.researchFocus) paper.description = sv.researchFocus;
        paper.projectId = sv.projectId; paper.researchArea = sv.researchArea;
    } else { 
        const svRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
        if (svRoot) {
            const svR = this.parse100SV(svRoot);
            if (!paper.projectId) paper.projectId = svR.projectId;
            if (!paper.researchArea) paper.researchArea = svR.researchArea;
            // If subpaper has no 100SV.md and no specific description, and root 100SV.md has focus, use it.
            if (!svSub && svR.researchFocus && paper.description === repo.description) paper.description = svR.researchFocus;
        }
    }

    let t = null, s = null, pVal = null;
    const progressMd = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/progress.md`);
    if (progressMd) {
      const prog = this.parseProgress(progressMd);
      paper.progress = prog;
      if (prog.title) t = prog.title; if (prog.status) s = prog.status;
      if (prog.priority) pVal = prog.priority;
      paper.preprintLink = prog.preprintLink; paper.publishedLink = prog.publishedLink;
    }

    if (t) { paper.title = t; paper.paperName = t; }
    const statusFromProgress = s;
    paper.status = s || (await this.inferStatusFromActivity(repo, `papers/${subpaperDir}/`));
    paper.priority = pVal || 'Medium';
    console.log(`DEBUG [${paper.fullName}]: Title='${paper.title}', Status(prog)='${statusFromProgress}', FinalStatus='${paper.status}', Prio='${paper.priority}'`);
    return paper;
  }

  async inferStatusFromActivity(repo, specificPath = null) {
    let dateToUse = repo.updated_at; 
    const allowPrivatePathCheck = true; 
    if (specificPath && (!repo.private || (repo.private && allowPrivatePathCheck))) {
        try {
            const { data: c } = await this.octokit.rest.repos.listCommits({ owner: repo.owner.login, repo: repo.name, path: specificPath, per_page: 1 });
            if (c.length > 0 && c[0].commit.committer?.date) dateToUse = c[0].commit.committer.date;
        } catch (e) { /* Use repo updated_at if path check fails */ }
    }
    const days = Math.floor((new Date() - new Date(dateToUse)) / (1000*60*60*24));
    const inferred = days < 7 ? 'Active' : days < 30 ? 'Recent' : days < 90 ? 'Inactive' : 'Stale';
    return inferred;
  }
  
  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    const targets = [{ type: 'user', name: this.owner }];
    this.papers = [];
    this.stats.recentActivity = []; // Reset recent activity
    this.repoWeeklyCommitsData.clear(); // Reset weekly commits map for the run
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
              
              const historicalData = await this.getHistoricalStats(repo);
              const weeklyCommitData = await this.getWeeklyCommits(repo.owner.login, repo.name, repo.private);

              if (weeklyCommitData && typeof weeklyCommitData.count === 'number') {
                this.repoWeeklyCommitsData.set(repo.full_name, weeklyCommitData.count);
              }

              if (weeklyCommitData.count > 0) {
                  this.stats.recentActivity.push({ 
                      repo: repo.full_name, // Use full_name for unique identification
                      commits: weeklyCommitData.count, 
                      lastCommit: weeklyCommitData.lastMessage 
                  });
              }
              
              console.log(`DEBUG: Analyzing paper structures in ${repo.full_name}...`);
              const paperItems = await this.analyzePaper(repo, historicalData, weeklyCommitData); 
              
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

  async is100SVRepository(repo) {
    try { 
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: '100SV.md', request: {retries:0}}); 
      return true; 
    } catch (e) {}
    return repo.topics?.includes('100-scientific-visions');
  }
  
  async analyzePaper(repo, historicalData, weeklyCommitData) { // Accept new params
    const list = []; 
    const subDirs = await this.findSubpapers(repo); 
    if (subDirs.length > 0) {
      for (const sd of subDirs) { 
        // Pass historicalData and weeklyCommitData to subpaper analysis
        const d = await this.analyzeSubpaper(repo, sd, historicalData, weeklyCommitData); 
        if (d) list.push(d); 
      }
    } else { 
      // Pass historicalData and weeklyCommitData to single paper analysis
      const d = await this.analyzeSinglePaper(repo, historicalData, weeklyCommitData); 
      if (d) list.push(d); 
    }
    return list;
  }

  async findSubpapers(repo) {
    const names = [];
    try {
      // Check if 'papers' directory exists first
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers', request: { retries: 0 }});
      const { data: c } = await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers' });
      if (Array.isArray(c)) c.forEach(item => { if (item.type === 'dir') names.push(item.name); });
    } catch (e) { /* 'papers' directory might not exist, which is fine */ }
    return names;
  }

  generateStats() {
    console.log("DEBUG: Generating stats based on processed papers...");
    this.stats.total = this.papers.length;
    this.stats.byStatus = {};
    this.stats.byPriority = {};
    // Initialize the new stat
    this.stats.totalLifetimeCommits = 0; 

    const processedReposForLifetimeCommits = new Set(); // To ensure each repo's lifetime commits are added only once

    this.papers.forEach(p => {
        const statusKey = p.status || 'Unknown';
        this.stats.byStatus[statusKey] = (this.stats.byStatus[statusKey] || 0) + 1;
        const priorityKey = p.priority || 'Medium';
        this.stats.byPriority[priorityKey] = (this.stats.byPriority[priorityKey] || 0) + 1;

        // Sum total lifetime commits, ensuring each repo is counted once
        // p.repoName refers to the repository's short name. 
        // If you have multiple repos with the same name under different owners (not your case here), 
        // you might use p.repoUrl or a combination of owner/repo for uniqueness.
        // For your setup, p.repoName is likely sufficient if all your repos are under your GITHUB_OWNER.
        // Alternatively, use p.fullName (which is owner/repo for main papers, owner/repo/subpaper for subpapers)
        // but we want to sum per *repository*, so p.repoUrl or p.historical.parentRepoFullName (if you add such a field) would be best.
        // Given that historical data is now attached at the repo level to each paper item, p.repoName is fine here.
        if (p.historical && typeof p.historical.totalLifetimeCommits === 'number' && !processedReposForLifetimeCommits.has(p.repoName)) {
            this.stats.totalLifetimeCommits += p.historical.totalLifetimeCommits;
            processedReposForLifetimeCommits.add(p.repoName);
        }
    });

    // Sum weekly commits from the data collected per repository
    this.stats.weeklyCommits = Array.from(this.repoWeeklyCommitsData.values()).reduce((sum, count) => sum + count, 0);

    // recentActivity is already sorted and sliced in discoverPapers
    console.log(`DEBUG: Final Stats: Total=${this.stats.total}, WeeklyCommits=${this.stats.weeklyCommits}, LifetimeCommits=${this.stats.totalLifetimeCommits}, Statuses=${JSON.stringify(this.stats.byStatus)}, Priorities=${JSON.stringify(this.stats.byPriority)}`);
  }

  async updateReadme() {
    console.log("DEBUG: Updating README.md...");
    const ts = new Date().toISOString().slice(0,16).replace('T',' ') + ' UTC';
    const hubUrl = (this.owner && this.repoFullName?.includes('/')) ? `https://${this.owner}.github.io/${this.repoFullName.split('/')[1]}/` : `<!-- Hub Dashboard URL Error -->`;
    let md = `# 100 Scientific Visions by Daniel Sandner

## Project Overview
A comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.

## Current Status Dashboard
*Last updated: ${ts}*

### Quick Stats
- 📊 **Total Papers Tracked**: ${this.stats.total}
- 🟢 **Active Projects**: ${this.stats.byStatus['Active']||0}
- 🟡 **In Planning**: ${this.stats.byStatus['Planning']||0}
- ⚪ **Recent Activity (but not 'Active')**: ${this.stats.byStatus['Recent']||0}
- 🔴 **Stale (Needs Attention)**: ${this.stats.byStatus['Stale']||0}
- 📈 **This Week's Commits (Tracked Repos)**: ${this.stats.weeklyCommits} 
- 📜 **Total Lifetime Commits (Tracked Repos)**: ${this.stats.totalLifetimeCommits || 0}

### Recent Activity (Top 10 Tracked Repos by Weekly Commits)
`;
    if(this.stats.recentActivity.length > 0) {
        this.stats.recentActivity.forEach(a => {
            // a.repo is now repo.full_name
            const repoDisplayName = a.repo; 
            const commitMsg = (a.lastCommit||"N/A").substring(0,70);
            md += `- **${repoDisplayName}**: ${a.commits} commits - "${commitMsg}${(a.lastCommit||"").length > 70 ? '...' : ''}"\n`;
        });
    } else {
        md += `*No recent commit activity detected (or commit fetching disabled/failed).*\n`;
    }
    md += `
## Research Areas
*Categorization based on repository topics or 'Research Area' in 100SV.md files.*

### By Status
`;
    const sts = Object.keys(this.stats.byStatus).sort(); 
    if(sts.length>0) {
        sts.forEach(s => {md += `- **${s}**: ${this.stats.byStatus[s]} papers\n`;});
    } else {
        md += `*No status data available.*\n`;
    }
    md += `
### Priority Distribution
`;
    const pri = Object.keys(this.stats.byPriority).sort((a,b)=>({'High':0,'Medium':1,'Low':2}[a]??99)-({'High':0,'Medium':1,'Low':2}[b]??99)); 
    if(pri.length>0) {
        pri.forEach(pVal=>{md+=`- ${this.getPriorityEmoji(pVal)} **${pVal} Priority**: ${this.stats.byPriority[pVal]} papers\n`;});
    } else {
        md += `*No priority data available.*\n`;
    }
    md += `
## Quick Actions & Links
- [📊 Interactive Dashboard](${hubUrl})
- [📋 View Detailed Progress Report](./reports/detailed-progress.md)
- [🔄 Update Status Manually](../../actions) (Run "Update Project Status" workflow)

## About This System
This dashboard is automatically updated by GitHub Actions. For more information on setup, repository identification, and customization, see [SETUP.md](./setup.md).

---

*This dashboard is part of the 100 Scientific Visions initiative by Daniel Sandner.*`;
    await fs.writeFile('README.md', md);
  }

  async generateDetailedReport() {
    console.log("DEBUG: Generating detailed report...");
    const now = new Date(); const genDate = now.toISOString().slice(0,10); const genTime = now.toTimeString().slice(0,8);
    let report = `# Detailed Progress Report\n*Generated: ${genDate} ${genTime} UTC*\n\n## All Tracked Paper Items (${this.papers.length} total)\n\n`;
    report += `| Title / Location                 | Status                      | Priority                      | Progress                               | Links                                     | Last Repo Update |\n`;
    report += `|:---------------------------------|:----------------------------|:------------------------------|:---------------------------------------|:------------------------------------------|:-----------------|\n`;
    if (this.papers.length === 0) { report += `| *No paper items found or tracked.* | - | - | - | - | - |\n`; }
    else {
      this.papers.forEach(p => {
        const displayName = p.title || p.paperName || 'Untitled';
        let locationHint = '';
        if (p.isSubpaper) { 
            locationHint = `<br><small>(${p.fullName})</small>`; // p.fullName is owner/repo/subpaperDir
        } else if (displayName !== p.repoName && p.repoName !== p.paperName) { 
            locationHint = `<br><small>(${p.repoName})</small>`;
        }
        const viewLink = `<a href="${p.url}" target="_blank" title="View Paper Location">View</a>`;
        const links = [viewLink];
        if (p.preprintLink) links.unshift(`<a href="${p.preprintLink}" target="_blank" title="Preprint">Preprint</a>`);
        if (p.publishedLink) links.unshift(`<a href="${p.publishedLink}" target="_blank" title="Published">Published</a>`);
        
        report += `| **${displayName}**${locationHint} | ${this.getStatusEmoji(p.status)} ${p.status||'N/A'} | ${this.getPriorityEmoji(p.priority)} ${p.priority||'N/A'} | \`${this.generateProgressBar(p.progress?.phase)}\` | ${links.join(' • ')} | ${new Date(p.lastUpdated).toLocaleDateString()} |\n`;
      });
    }
    report += `\n## Detailed Information by Repository\n`;
    const papersByRepo = this.papers.reduce((acc,item) => { (acc[item.repoName] = acc[item.repoName] || []).push(item); return acc; }, {});
    if (Object.keys(papersByRepo).length === 0) { report += `*No repositories to detail.*\n`; }
    else {
      Object.keys(papersByRepo).sort().forEach(repoName => {
        const itemsInRepo = papersByRepo[repoName]; 
        const repoDataForHeader = itemsInRepo[0]; // All items in this list now share parent repo's historical/commit data

        report += `\n### 📁 Repository: [${repoName}](${repoDataForHeader.repoUrl})\n`;
        
        const mainNonSubpaperItem = itemsInRepo.find(it => !it.isSubpaper);
        const descriptionToDisplay = mainNonSubpaperItem?.description || repoDataForHeader.description || 'N/A';
        report += `- **Repo/Project Description**: ${descriptionToDisplay}\n`;
        report += `- **Topics**: ${(repoDataForHeader.topics||[]).join(', ') || 'None'}\n`;
        report += `- **Visibility**: ${repoDataForHeader.private ? 'Private' : 'Public'}\n`;
        
        // All items (main or subpaper) from the same repo now carry identical .historical and .commitsLastWeek
        const hist = repoDataForHeader.historical; // Use any item's historical data as it's repo-wide
        if (hist) { 
            report += `- **Created**: ${new Date(hist.createdAt).toLocaleDateString()} (${hist.age} days ago)\n`; 
            if (typeof hist.totalCommits3Months === 'number' && (!repoDataForHeader.private || hist.totalCommits3Months > 0 ) ) {
                report += `- **Commits (3 months)**: ${hist.totalCommits3Months}\n`; 
            }
            if (typeof hist.totalLifetimeCommits === 'number' && (!repoDataForHeader.private || hist.totalLifetimeCommits > 0)) {
                report += `- **Total Lifetime Commits**: ${hist.totalLifetimeCommits}\n`;
            }
        }
        // Use any item's commitsLastWeek as it's repo-wide
        if (typeof repoDataForHeader.commitsLastWeek === 'number' && (!repoDataForHeader.private || repoDataForHeader.commitsLastWeek > 0)) {
            report += `- **Weekly Commits (this repo)**: ${repoDataForHeader.commitsLastWeek}\n`;
        }

        if (itemsInRepo.length === 1 && !itemsInRepo[0].isSubpaper) {
          const p = itemsInRepo[0]; 
          report += `- **Paper Title**: ${p.title||p.paperName||'N/A'}\n`;
          report += `- **Status**: ${this.getStatusEmoji(p.status)} ${p.status||'N/A'}\n`;
          report += `- **Priority**: ${this.getPriorityEmoji(p.priority)} ${p.priority||'N/A'}\n`;
          report += `- **Progress**: \`${this.generateProgressBar(p.progress?.phase)}\`\n`;
          if (p.projectId) report += `- **Project ID**: ${p.projectId}\n`; 
          if (p.researchArea) report += `- **Research Area**: ${p.researchArea}\n`; 
          if (p.preprintLink) report += `- **Preprint**: [Link](${p.preprintLink})\n`; 
          if (p.publishedLink) report += `- **Published**: [Link](${p.publishedLink})\n`;
        } else { 
          report += `\n  *Contains ${itemsInRepo.length} paper items:*\n`;
          itemsInRepo.forEach(p => { 
            report += `  - #### ${this.getStatusEmoji(p.status)} ${p.title||p.paperName||'Untitled Sub-paper'}\n`; 
            if (p.title && p.paperName !== p.title && p.isSubpaper) { report += `    - **Directory Name**: \`${p.paperName}\`\n`; }
            if (p.description && p.description !== descriptionToDisplay) {
                 report += `    - **Description (Specific)**: ${p.description}\n`;
            }
            report += `    - **Status**: ${p.status||'N/A'} | **Priority**: ${p.priority||'N/A'}\n`; 
            report += `    - **Progress**: \`${this.generateProgressBar(p.progress?.phase)}\`\n`;
            if (p.projectId) report += `    - **Project ID**: ${p.projectId}\n`; 
            if (p.researchArea) report += `    - **Research Area**: ${p.researchArea}\n`; 
            if (p.preprintLink) report += `    - **Preprint**: [Link](${p.preprintLink})\n`; 
            if (p.publishedLink) report += `    - **Published**: [Link](${p.publishedLink})\n`; 
            report += `    - **Link**: [View Paper Directory](${p.url})\n\n`;
          });
        }
        report += `\n---\n`;
      });
    }
    await fs.mkdir('reports', { recursive: true }); // Ensure reports directory exists
    await fs.writeFile('reports/detailed-progress.md', report);
  }

  generateProgressBar(phases=[]) {
    const totalPhases = 12; const completed = Array.isArray(phases) ? phases.length : 0;
    if (totalPhases === 0) return `░░░░░░░░░░ 0% (No phases defined)`; // Should not happen if totalPhases=12
    const percentage = Math.round((completed / totalPhases) * 100); 
    const filledBlocks = Math.min(10, Math.round((completed / totalPhases) * 10));
    const emptyBlocks = 10 - filledBlocks;
    return `${'█'.repeat(filledBlocks)}${'░'.repeat(emptyBlocks)} ${percentage}%`;
  }
  getStatusEmoji(status) {
    const emojis = {'Active':'🟢','Planning':'🟡','Review':'🔵','Complete':'✅','Stale':'🔴','Inactive':'⚪','Recent':'🟠','Analysis':'🟣','Writing':'✍️','On-Hold':'⏸️','Unknown':'❓'};
    return emojis[status] || '❓';
  }
  getPriorityEmoji(priority) {
    const emojis = {'High':'🔴','Medium':'🟡','Low':'🟢'};
    return emojis[priority] || '⚪';
  }

  async saveData() {
    await fs.mkdir('data', {recursive:true});
    const sortedPapers = [...this.papers].sort((a,b)=>(a.fullName||'').localeCompare(b.fullName||''));
    await fs.writeFile('data/papers.json', JSON.stringify(sortedPapers,null,2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats,null,2));
  }

  async run() {
    console.log('🚀 Starting Scientific Visions Tracker...');
    if(!this.owner){console.error("❌ GITHUB_OWNER environment variable missing. Cannot determine scan targets."); process.exit(1);}
    
    // --- PAT TEST BLOCK --- (Keep commented out unless actively debugging PAT)
    /* 
    try {
        const privateRepoOwner = 'sandner-art'; // Your username or org
        const privateRepoName = 'SC-Noton';    // Your private repo name
        console.log(`DEBUG_PAT_TEST: Attempting to fetch specific private repo '${privateRepoOwner}/${privateRepoName}' directly...`);
        const { data: specificRepo } = await this.octokit.rest.repos.get({
            owner: privateRepoOwner, repo: privateRepoName,
        });
        console.log(`DEBUG_PAT_TEST: Successfully fetched ${privateRepoName}. Private: ${specificRepo.private}, Name: ${specificRepo.full_name}`);
        console.log(`DEBUG_PAT_TEST: Attempting to list files in ${privateRepoName} root...`);
        const { data: files } = await this.octokit.rest.repos.getContent({
            owner: privateRepoOwner, repo: privateRepoName, path: '',
        });
        console.log(`DEBUG_PAT_TEST: Found ${files.length} files/dirs in ${privateRepoName} root. First item: ${files[0]?.name}`);
    } catch (error) {
        console.error(`DEBUG_PAT_TEST: ERROR accessing '${privateRepoName}'. Status: ${error.status}, Message: ${error.message}`);
    }
    */
    // --- END PAT TEST BLOCK ---
    
    await this.discoverPapers();
    this.generateStats(); 
    await this.updateReadme(); 
    await this.generateDetailedReport(); 
    await this.saveData(); 
    
    console.log('🎉 Tracker run complete!');
    console.log(`📊 Total papers processed: ${this.stats.total}.`);
    console.log(`📈 Total weekly commits for tracked repos: ${this.stats.weeklyCommits}. (Ensure PAT has access to private repos for full count)`);
  }
}
(async()=>{
  const tracker = new ScientificVisionsTracker();
  try {
    await tracker.run();
  } catch(e) {
    console.error("❌ Global Error in tracker execution:", e);
    process.exit(1);
  }
})();