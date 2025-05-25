const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.owner = process.env.GITHUB_OWNER;
    this.repoFullName = process.env.GITHUB_REPOSITORY; // e.g., "owner/repo-name"
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [], // For README: { repo: paper.fullName, commits: weeklyRepoCommits, lastCommit: firstCommitMessage }
      weeklyCommits: 0 // Overall total weekly commits for README
    };
  }

  async parseFileContent(owner, repoName, filePath) {
    // console.log(`DEBUG: Attempting to read file: ${owner}/${repoName}/${filePath}`);
    try {
      const { data: file } = await this.octokit.rest.repos.getContent({
        owner, repo: repoName, path: filePath
      });
      if (file.content) {
        return Buffer.from(file.content, 'base64').toString();
      }
    } catch (error) { /* console.log(`DEBUG: File not found: ${filePath}`); */ }
    return null;
  }

  parseProgress(content) {
    const progress = {
      title: null, status: null, priority: null, phase: [], preprintLink: null, publishedLink: null
    };

    // Extract Paper Title: **Paper Title**: Value (can be multi-word)
    const titleMatch = content.match(/^\*\*Paper Title\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (titleMatch && titleMatch[1]) {
        progress.title = titleMatch[1].trim(); // This handles multi-word titles
    }

    const statusMatch = content.match(/\*\*Status\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (statusMatch && statusMatch[1]) progress.status = statusMatch[1].trim();

    const priorityMatch = content.match(/\*\*Priority\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (priorityMatch && priorityMatch[1]) progress.priority = priorityMatch[1].trim();
    
    const preprintRegex = /(?:\*\*Preprint\*\*|\*\*arXiv\*\*):\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s(\[]+))/im;
    const preprintMatchResult = content.match(preprintRegex);
    if (preprintMatchResult) {
        const url = (preprintMatchResult[1] || preprintMatchResult[2] || '').trim();
        if (url && !url.toLowerCase().startsWith('[link')) progress.preprintLink = url;
    }

    const publishedRegex = /(?:\*\*Published\*\*|\*\*DOI\*\*):\s*(?:\[[^\]]+\]\(([^)]+)\)|([^\s(\[]+))/im;
    const publishedMatchResult = content.match(publishedRegex);
    if (publishedMatchResult) {
        const url = (publishedMatchResult[1] || publishedMatchResult[2] || '').trim();
        if (url && !url.toLowerCase().startsWith('[doi')) progress.publishedLink = url;
    }

    const phaseMatches = content.match(/- \[x\]\s*([^\n]+)/gim);
    if (phaseMatches) progress.phase = phaseMatches.map(match => match.replace(/- \[x\]\s*/i, '').trim());
    
    return progress;
  }
  
  parse100SV(content) {
    const svData = { projectId: null, researchArea: null, researchFocus: null };

    const idMatch = content.match(/\*\*Project ID\*\*:\s*\[?([^\]\n]+?)\]?/im);
    if (idMatch && idMatch[1]) svData.projectId = idMatch[1].trim();

    const areaMatch = content.match(/\*\*Research Area\*\*:\s*\[?([^\]\n]+?)\]?/im);
    if (areaMatch && areaMatch[1]) svData.researchArea = areaMatch[1].trim();

    // Get the entire research focus, not just the first line
    const focusMatch = content.match(/## Research Focus\s*\n+([\s\S]*?)(?=\n##|\n---|\n\*{3,}|$)/im);
    if (focusMatch && focusMatch[1]) svData.researchFocus = focusMatch[1].trim(); 

    return svData;
  }

  async getHistoricalStats(repo) {
    // console.log(`DEBUG [${repo.name}]: Getting historical stats...`);
    try {
      const createdAt = new Date(repo.created_at);
      const now = new Date();
      const ageInDays = Math.floor((now - createdAt) / (1000 * 60 * 60 * 24));
      let totalCommits3Months = 0;

      if (!repo.private) {
        try {
          const threeMonthsAgo = new Date();
          threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
          const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repo.owner.login, repo: repo.name, since: threeMonthsAgo.toISOString(), per_page: 100,
          });
          for await (const { data: commitPage } of iterator) { totalCommits3Months += commitPage.length; }
        //   console.log(`DEBUG [${repo.name}]: 3-month commits: ${totalCommits3Months}`);
        } catch (error) { /* console.log(`⚠️ Cannot access 3-month commit history for public repo ${repo.name}`); */ }
      }
      return { age: ageInDays, totalCommits3Months, createdAt: repo.created_at };
    } catch (error) { console.error(`❌ Error getting historical stats for ${repo.name}: ${error.message}`); return null; }
  }

  async getWeeklyCommits(repoOwner, repoName) {
    // console.log(`DEBUG [${repoName}]: Getting weekly commits...`);
    let weeklyRepoCommits = 0;
    let firstCommitMessage = null;
    try {
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repoOwner, repo: repoName, since: weekAgo.toISOString(), per_page: 100,
        });
        for await (const { data: commitsPage } of iterator) {
            if (commitsPage.length > 0 && !firstCommitMessage) {
                firstCommitMessage = commitsPage[0].commit.message.split('\n')[0];
            }
            weeklyRepoCommits += commitsPage.length;
        }
        // console.log(`DEBUG [${repoName}]: Weekly commits: ${weeklyRepoCommits}`);
    } catch (error) { /* console.log(`⚠️ Cannot access weekly commit data for public repo ${repoName}`); */ }
    return { count: weeklyRepoCommits, lastMessage: firstCommitMessage };
  }


  async analyzeSinglePaper(repo) {
    const paper = {
      repoName: repo.name, paperName: repo.name, fullName: repo.name,
      description: repo.description || 'No repository description.',
      url: repo.html_url, repoUrl: repo.html_url, private: repo.private,
      topics: repo.topics || [], lastUpdated: repo.updated_at, title: null,
      status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      commitsLastWeek: 0, // Specific to this paper entry (if it's a repo)
      historical: null, // Will hold .age, .totalCommits3Months
      preprintLink: null, publishedLink: null, isSubpaper: false,
      projectId: null, researchArea: null,
    };

    const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
    if (svContentRoot) {
        const svData = this.parse100SV(svContentRoot);
        paper.description = svData.researchFocus || paper.description;
        paper.projectId = svData.projectId;
        paper.researchArea = svData.researchArea;
    }

    let titleFromProgressMd = null, statusFromProgressMd = null, priorityFromProgressMd = null;
    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, 'papers/progress.md');
    if (progressContent) {
      const parsed = this.parseProgress(progressContent);
      paper.progress = parsed; // Store all fields like .phase
      if (parsed.title) titleFromProgressMd = parsed.title;
      if (parsed.status) statusFromProgressMd = parsed.status;
      if (parsed.priority) priorityFromProgressMd = parsed.priority;
      paper.preprintLink = parsed.preprintLink; paper.publishedLink = parsed.publishedLink;
    }

    if (titleFromProgressMd) { paper.title = titleFromProgressMd; paper.paperName = titleFromProgressMd; }
    paper.status = statusFromProgressMd || (await this.inferStatusFromActivity(repo, 'papers/'));
    paper.priority = priorityFromProgressMd || 'Medium';
    
    paper.historical = await this.getHistoricalStats(repo); // Get age, 3-month commits
    if (!repo.private) {
        const weeklyData = await this.getWeeklyCommits(repo.owner.login, repo.name);
        paper.commitsLastWeek = weeklyData.count; // Store on the paper object
        if (weeklyData.count > 0) {
            this.stats.recentActivity.push({ repo: paper.fullName, commits: weeklyData.count, lastCommit: weeklyData.lastMessage || "N/A" });
        }
        // this.stats.weeklyCommits is aggregated in generateStats based on all paper.commitsLastWeek
    }
    return paper;
  }

  async analyzeSubpaper(repo, subpaperDir) {
    const paper = {
      repoName: repo.name, paperName: subpaperDir, fullName: `${repo.name}/${subpaperDir}`,
      description: repo.description || 'No repository description.', // Inherits repo desc
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`, repoUrl: repo.html_url,
      private: repo.private, topics: repo.topics || [], lastUpdated: repo.updated_at,
      title: null, status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      // commitsLastWeek & historical are typically repo-level, not duplicated for sub-papers here
      // unless explicitly needed and calculated, which would be complex.
      preprintLink: null, publishedLink: null, isSubpaper: true,
      projectId: null, researchArea: null
    };

    const svContentSub = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/100SV.md`);
    if (svContentSub) {
        const svData = this.parse100SV(svContentSub);
        paper.description = svData.researchFocus || paper.description; // Prefer sub-paper's focus
        paper.projectId = svData.projectId; paper.researchArea = svData.researchArea;
    } else {
        const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
        if (svContentRoot) {
            const svDataRoot = this.parse100SV(svContentRoot);
            if (!paper.projectId) paper.projectId = svDataRoot.projectId;
            if (!paper.researchArea) paper.researchArea = svDataRoot.researchArea;
            if (!svContentSub && svDataRoot.researchFocus && paper.description === repo.description) {
                 // If no sub-100SV.md researchFocus, and root has one, and current desc is just repo's.
                paper.description = svDataRoot.researchFocus;
            }
        }
    }

    let titleFromProgressMd = null, statusFromProgressMd = null, priorityFromProgressMd = null;
    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/progress.md`);
    if (progressContent) {
      const parsed = this.parseProgress(progressContent);
      paper.progress = parsed;
      if (parsed.title) titleFromProgressMd = parsed.title;
      if (parsed.status) statusFromProgressMd = parsed.status;
      if (parsed.priority) priorityFromProgressMd = parsed.priority;
      paper.preprintLink = parsed.preprintLink; paper.publishedLink = parsed.publishedLink;
    }

    if (titleFromProgressMd) { paper.title = titleFromProgressMd; paper.paperName = titleFromProgressMd; }
    paper.status = statusFromProgressMd || (await this.inferStatusFromActivity(repo, `papers/${subpaperDir}/`));
    paper.priority = priorityFromProgressMd || 'Medium';

    // Sub-papers don't typically get their own separate historical/weekly commit counts here.
    // These stats are usually associated with the parent repository.
    // If a sub-paper entry needs to reflect repo-level commit stats, it would be passed down or looked up.
    // For now, they will be null/0 for sub-paper specific fields.
    // The parent repo's `analyzeSinglePaper` (if the repo is also treated as a paper) would hold them.
    // Or, the `generateDetailedReport` can look up parent repo stats.

    return paper;
  }

  async inferStatusFromActivity(repo, specificPath = null) {
    let lastCommitDateToUse = repo.updated_at; 
    if (specificPath && !repo.private) {
        try {
            const { data: commits } = await this.octokit.rest.repos.listCommits({
                owner: repo.owner.login, repo: repo.name, path: specificPath, per_page: 1
            });
            if (commits.length > 0 && commits[0].commit.committer?.date) {
                lastCommitDateToUse = commits[0].commit.committer.date;
            }
        } catch (err) { /* console.warn(`Could not get path-specific commits for ${repo.name}/${specificPath}.`); */ }
    }
    const days = Math.floor((new Date() - new Date(lastCommitDateToUse)) / (1000*60*60*24));
    if (days < 7) return 'Active'; if (days < 30) return 'Recent';
    if (days < 90) return 'Inactive'; return 'Stale';
  }
  
  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    const targets = [{ type: 'user', name: this.owner }];
    let discoveredPaperItems = 0;
    try {
      for (const target of targets) {
        const repoListParams = target.type === 'org' 
          ? { org: target.name, type: 'all', per_page: 100 }
          : { username: target.name, type: 'all', per_page: 100 };
        
        for await (const { data: reposPage } of this.octokit.paginate.iterator(
          target.type === 'org' ? this.octokit.rest.repos.listForOrg : this.octokit.rest.repos.listForUser,
          repoListParams
        )) {
          for (const repo of reposPage) {
            if (this.repoFullName && repo.full_name === this.repoFullName) {
                // console.log(`DEBUG: Explicitly skipping self (hub repository): ${repo.full_name}`);
                continue; 
            }
            if (await this.is100SVRepository(repo)) {
              const paperList = await this.analyzePaper(repo); // Returns array of paper objects
              if (paperList && paperList.length > 0) {
                this.papers.push(...paperList);
                discoveredPaperItems += paperList.length;
              }
            }
          }
        }
      }
      console.log(`📊 Found ${discoveredPaperItems} paper items.`);
      this.papers.sort((a,b) => (a.fullName || '').localeCompare(b.fullName || ''));
    } catch (error) { console.error(`❌ Error discovering papers: ${error.message}`, error.stack); }
  }

  async is100SVRepository(repo) {
    try { // Primary: 100SV.md file
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: '100SV.md' });
      return true;
    } catch (error) { /* try next */ }
    // Secondary: topic tag
    return repo.topics && repo.topics.includes('100-scientific-visions');
  }
  
  async analyzePaper(repo) {
    const papersList = [];
    const subpaperDirs = await this.findSubpapers(repo); 
    if (subpaperDirs.length > 0) {
      for (const subpaperDir of subpaperDirs) {
        const paperData = await this.analyzeSubpaper(repo, subpaperDir);
        if (paperData) papersList.push(paperData);
      }
    } else {
      const paperData = await this.analyzeSinglePaper(repo);
      if (paperData) papersList.push(paperData);
    }
    return papersList;
  }

  async findSubpapers(repo) {
    const subpaperNames = [];
    try {
      // Check if 'papers' directory itself exists first
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers', request: { retries: 0 } });
      // If above doesn't throw, 'papers' exists. Now get its contents.
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner: repo.owner.login, repo: repo.name, path: 'papers'
      });
      if (Array.isArray(contents)) {
        for (const item of contents) {
            if (item.type === 'dir') subpaperNames.push(item.name);
        }
      }
    } catch (error) { /* 'papers' dir likely doesn't exist or other issue */ }
    return subpaperNames;
  }

  generateStats() {
    this.stats.total = this.papers.length;
    this.stats.byStatus = {};
    this.stats.byPriority = {};
    let totalWeeklyCommits = 0;

    this.papers.forEach(paper => { 
        const statusKey = paper.status || 'Unknown'; 
        this.stats.byStatus[statusKey] = (this.stats.byStatus[statusKey] || 0) + 1; 
        
        const priorityKey = paper.priority || 'Medium'; 
        this.stats.byPriority[priorityKey] = (this.stats.byPriority[priorityKey] || 0) + 1; 

        // Aggregate weekly commits from individual paper entries (for non-subpapers)
        // Sub-papers don't carry their own commit counts in this model, they reflect repo activity.
        if (!paper.isSubpaper && paper.commitsLastWeek) {
            totalWeeklyCommits += paper.commitsLastWeek;
        }
    });
    // If a repo with subpapers is NOT also treated as a single paper, its commits might be missed.
    // A more robust way is to sum unique repo weekly commits.
    const uniqueRepoCommits = new Map();
    this.papers.forEach(p => {
        if (!p.isSubpaper && p.commitsLastWeek > 0) { // Only count for main paper entries of a repo
            uniqueRepoCommits.set(p.repoName, p.commitsLastWeek);
        }
    });
    this.stats.weeklyCommits = Array.from(uniqueRepoCommits.values()).reduce((sum, count) => sum + count, 0);


    this.stats.recentActivity.sort((a, b) => b.commits - a.commits); // recentActivity is already populated
    this.stats.recentActivity = this.stats.recentActivity.slice(0, 10);
  }

  async updateReadme() {
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    let dashboardUrl = ``;
    if (this.owner && this.repoFullName && this.repoFullName.includes('/')) {
        dashboardUrl = `https://${this.owner}.github.io/${this.repoFullName.split('/')[1]}/`;
    } else { dashboardUrl = `<!-- Hub repo owner/name not found. Update link. -->`; }

    let readme = `# 100 Scientific Visions by Daniel Sandner\n\n## Project Overview\n...\n\n## Current Status Dashboard\n*Last updated: ${timestamp}*\n\n### Quick Stats\n- 📊 **Total Papers Tracked**: ${this.stats.total}\n- 🟢 **Active Projects**: ${this.stats.byStatus['Active'] || 0}\n- 🟡 **In Planning**: ${this.stats.byStatus['Planning'] || 0}\n- 🔴 **Stale (Needs Attention)**: ${this.stats.byStatus['Stale'] || 0}\n- 📈 **This Week's Commits (Public Repos)**: ${this.stats.weeklyCommits}\n\n### Recent Activity (Top 10 Public Repos by Weekly Commits)\n`;
    if (this.stats.recentActivity.length > 0) { this.stats.recentActivity.forEach(act => { readme += `- **${act.repo}**: ${act.commits} commits - "${act.lastCommit.substring(0,70)}${act.lastCommit.length > 70 ? '...' : ''}"\n`; }); } else { readme += '*No recent commit activity.*\n'; }
    readme += `\n## Research Areas\n...\n\n### By Status\n`;
    const statuses = Object.keys(this.stats.byStatus).sort();
    if (statuses.length>0) statuses.forEach(s => { readme += `- **${s}**: ${this.stats.byStatus[s]} papers\n`; }); else readme += `*No status data.*\n`;
    readme += `\n### Priority Distribution\n`;
    const priorities = Object.keys(this.stats.byPriority).sort((a,b) => ({High:0,Medium:1,Low:2}[a] ?? 99) - ({High:0,Medium:1,Low:2}[b] ?? 99));
    if (priorities.length>0) priorities.forEach(p => { readme += `- ${this.getPriorityEmoji(p)} **${p} Priority**: ${this.stats.byPriority[p]} papers\n`; }); else readme += `*No priority data.*\n`;
    readme += `\n## Quick Actions & Links\n- [📊 Interactive Dashboard](${dashboardUrl})\n...\n---`;
    await fs.writeFile('README.md', readme);
  }

  async generateDetailedReport() {
    const now = new Date(); const genDate = now.toISOString().slice(0,10); const genTime = now.toTimeString().slice(0,8);
    let report = `# Detailed Progress Report\n*Generated: ${genDate} ${genTime} UTC*\n\n## All Tracked Paper Items (${this.papers.length} total)\n\n`;
    report += `| Title / Location | Status | Priority | Progress | Links | Last Repo Update |\n`;
    report += `|:---|:---|:---|:---|:---|:---|\n`;
    if (this.papers.length === 0) { report += `| *No papers found.* | - | - | - | - | - |\n`; }
    else {
      this.papers.forEach(p => {
        const dName = p.title || p.paperName || 'Untitled';
        let locHint = p.isSubpaper ? `<br><small>(${p.fullName})</small>` : (dName !== p.repoName ? `<br><small>(${p.repoName})</small>` : '');
        const links = [`<a href="${p.url}" target="_blank">View</a>`];
        if (p.preprintLink) links.unshift(`<a href="${p.preprintLink}" target="_blank">Preprint</a>`);
        // if (p.publishedLink) links.unshift(`<a href="${p.publishedLink}" target="_blank">Published</a>`); // Add if needed
        report += `| **${dName}**${locHint} | ${this.getStatusEmoji(p.status)} ${p.status||'N/A'} | ${this.getPriorityEmoji(p.priority)} ${p.priority||'N/A'} | \`${this.generateProgressBar(p.progress?.phase)}\` | ${links.join(' • ')} | ${new Date(p.lastUpdated).toLocaleDateString()} |\n`;
      });
    }
    report += `\n## Detailed Information by Repository\n`;
    const papersByRepo = this.papers.reduce((acc,item) => { (acc[item.repoName] = acc[item.repoName] || []).push(item); return acc; }, {});
    if (Object.keys(papersByRepo).length === 0) report += `*No repositories to detail.*\n`;
    else {
      Object.keys(papersByRepo).sort().forEach(repoName => {
        const items = papersByRepo[repoName]; const rData = items[0]; // for common repo data
        report += `\n### 📁 Repository: [${repoName}](${rData.repoUrl})\n`;
        report += `- **Repo Description**: ${rData.description || 'N/A'}\n`;
        report += `- **Topics**: ${(rData.topics||[]).join(', ') || 'None'}\n`;
        report += `- **Visibility**: ${rData.private ? 'Private' : 'Public'}\n`;
        if (rData.historical) { report += `- **Created**: ${new Date(rData.historical.createdAt).toLocaleDateString()} (${rData.historical.age} days ago)\n`; if (!rData.private && rData.historical.totalCommits3Months) report += `- **Commits (3m)**: ${rData.historical.totalCommits3Months}\n`; }
        // Display weekly commits for the repo (from the first non-subpaper item, or if only subpapers, it won't show here)
        const mainPaperItemForRepo = items.find(it => !it.isSubpaper && it.commitsLastWeek > 0);
        if (mainPaperItemForRepo) report += `- **Weekly Commits (repo)**: ${mainPaperItemForRepo.commitsLastWeek}\n`;

        if (items.length === 1 && !items[0].isSubpaper) { // Single paper repo
          const p = items[0]; report += `- **Paper Title**: ${p.title||p.paperName||'N/A'}\n- **Status**: ${this.getStatusEmoji(p.status)} ${p.status||'N/A'}\n... (rest of details)\n`;
        } else { // Multi-paper repo
          report += `\n  *Contains ${items.length} paper items:*\n`;
          items.forEach(p => { report += `  - #### ${this.getStatusEmoji(p.status)} ${p.title||p.paperName||'Sub-paper'}\n ... (rest of details)\n`; });
        }
        report += `\n---\n`;
      });
    }
    await fs.writeFile('reports/detailed-progress.md', report);
  }

  generateProgressBar(phases=[]) {
    const total = 12; const c = phases.length; if (total === 0) return `0%`;
    const p = Math.round((c/total)*100); const f = Math.min(10,Math.round((c/total)*10));
    return `${'█'.repeat(f)}${'░'.repeat(10-f)} ${p}%`;
  }
  getStatusEmoji(s) { return ({Active:'🟢',Planning:'🟡',Review:'🔵',Complete:'✅',Stale:'🔴',Inactive:'⚪',Recent:'🟠',Analysis:'🟣',Writing:'✍️','On-Hold':'⏸️',Unknown:'❓'})[s]||'❓'; }
  getPriorityEmoji(p) { return ({High:'🔴',Medium:'🟡',Low:'🟢'})[p]||'⚪'; }

  async saveData() {
    await fs.mkdir('data', { recursive: true });
    const sorted = [...this.papers].sort((a,b) => (a.fullName||'').localeCompare(b.fullName||''));
    await fs.writeFile('data/papers.json', JSON.stringify(sorted, null, 2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats, null, 2));
  }

  async run() {
    console.log('🚀 Starting Tracker...');
    if (!this.owner) { console.error("❌ GITHUB_OWNER missing."); process.exit(1); }
    if (process.env.SKIP_HUB_REPO === 'true' && !this.repoFullName) {
        // console.warn("⚠️ Hub repo name (GITHUB_REPOSITORY) not available to skip, but SKIP_HUB_REPO is true.");
    }
    await this.discoverPapers();
    this.generateStats(); 
    await this.updateReadme(); 
    await this.generateDetailedReport(); 
    await this.saveData(); 
    console.log('🎉 Done!');
  }
}
(async () => { await new ScientificVisionsTracker().run(); })().catch(e => { console.error("❌ Global Error:", e); process.exit(1); });