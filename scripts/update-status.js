const { Octokit } = require('@octokit/rest');
const fs = require('fs').promises;

class ScientificVisionsTracker {
  constructor() {
    this.octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN
    });
    this.owner = process.env.GITHUB_OWNER;
    this.repoFullName = process.env.GITHUB_REPOSITORY; // e.g., "owner/hub-repo-name"
    this.papers = [];
    this.stats = {
      total: 0,
      byStatus: {},
      byPriority: {},
      recentActivity: [], 
      weeklyCommits: 0 
    };
  }

  async parseFileContent(owner, repoName, filePath) {
    // console.log(`DEBUG: Reading ${owner}/${repoName}/${filePath}`);
    try {
      const { data: file } = await this.octokit.rest.repos.getContent({
        owner, repo: repoName, path: filePath, request: { retries: 0 }
      });
      if (file.content) {
        return Buffer.from(file.content, 'base64').toString();
      }
    } catch (error) { /* File not found or other access error */ }
    return null;
  }

  parseProgress(content) {
    const progress = {
      title: null, status: null, priority: null, phase: [], preprintLink: null, publishedLink: null
    };

    const titleMatch = content.match(/^\*\*Paper Title\*\*:\s*\[?([^\]\n]+?)\]?(?:\s|$)/im);
    if (titleMatch && titleMatch[1]) progress.title = titleMatch[1].trim();

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
    const focusMatch = content.match(/## Research Focus\s*\n+([\s\S]*?)(?=\n##|\n---|\n\*{3,}|$)/im);
    // Capture the full research focus, not just the first line, for description purposes.
    if (focusMatch && focusMatch[1]) svData.researchFocus = focusMatch[1].trim(); 
    return svData;
  }

  async getHistoricalStats(repo) {
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
        } catch (error) { /* Suppress error for this specific stat */ }
      }
      return { age: ageInDays, totalCommits3Months, createdAt: repo.created_at };
    } catch (error) { console.error(`Error getting historical stats for ${repo.name}: ${error.message}`); return null; }
  }

  async getWeeklyCommits(repoOwner, repoName) {
    let weeklyRepoCommits = 0;
    let firstCommitMessage = null;
    if (!repoOwner || !repoName) return { count: 0, lastMessage: null };
    try {
        const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 7);
        const iterator = this.octokit.paginate.iterator(this.octokit.rest.repos.listCommits, {
            owner: repoOwner, repo: repoName, since: weekAgo.toISOString(), per_page: 100,
        });
        for await (const { data: commitsPage } of iterator) {
            if (commitsPage.length > 0 && !firstCommitMessage && commitsPage[0].commit) {
                firstCommitMessage = commitsPage[0].commit.message.split('\n')[0];
            }
            weeklyRepoCommits += commitsPage.length;
        }
    } catch (error) { /* Suppress error for this specific stat */ }
    return { count: weeklyRepoCommits, lastMessage: firstCommitMessage };
  }

  async analyzeSinglePaper(repo) {
    const paper = {
      repoName: repo.name, paperName: repo.name, fullName: repo.name,
      description: repo.description || 'No repository description provided.',
      url: repo.html_url, repoUrl: repo.html_url, private: repo.private,
      topics: repo.topics || [], lastUpdated: repo.updated_at, title: null,
      status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      commitsLastWeek: 0, historical: null,
      preprintLink: null, publishedLink: null, isSubpaper: false,
      projectId: null, researchArea: null,
    };

    const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
    if (svContentRoot) {
        const svData = this.parse100SV(svContentRoot);
        if (svData.researchFocus) paper.description = svData.researchFocus;
        paper.projectId = svData.projectId;
        paper.researchArea = svData.researchArea;
    }

    let titleFromProgress = null, statusFromProgress = null, priorityFromProgress = null;
    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, 'papers/progress.md');
    if (progressContent) {
      const p = this.parseProgress(progressContent);
      paper.progress = p; 
      if (p.title) titleFromProgress = p.title;
      if (p.status) statusFromProgress = p.status;
      if (p.priority) priorityFromProgress = p.priority;
      paper.preprintLink = p.preprintLink; paper.publishedLink = p.publishedLink;
    }

    if (titleFromProgress) { paper.title = titleFromProgress; paper.paperName = titleFromProgress; }
    paper.status = statusFromProgress || (await this.inferStatusFromActivity(repo, 'papers/'));
    paper.priority = priorityFromProgress || 'Medium';
    
    paper.historical = await this.getHistoricalStats(repo);
    if (!repo.private) {
        const weekly = await this.getWeeklyCommits(repo.owner.login, repo.name);
        paper.commitsLastWeek = weekly.count;
        if (weekly.count > 0) {
            this.stats.recentActivity.push({ repo: paper.fullName, commits: weekly.count, lastCommit: weekly.lastMessage || "N/A" });
        }
    }
    return paper;
  }

  async analyzeSubpaper(repo, subpaperDir) {
    const paper = {
      repoName: repo.name, paperName: subpaperDir, fullName: `${repo.name}/${subpaperDir}`,
      description: repo.description || 'No repository description provided.',
      url: `${repo.html_url}/tree/main/papers/${subpaperDir}`, repoUrl: repo.html_url,
      private: repo.private, topics: repo.topics || [], lastUpdated: repo.updated_at,
      title: null, status: 'Unknown', priority: 'Medium', progress: { phase: [] },
      preprintLink: null, publishedLink: null, isSubpaper: true,
      projectId: null, researchArea: null
    };

    const svContentSub = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/100SV.md`);
    if (svContentSub) {
        const svData = this.parse100SV(svContentSub);
        if (svData.researchFocus) paper.description = svData.researchFocus;
        paper.projectId = svData.projectId; paper.researchArea = svData.researchArea;
    } else { 
        const svContentRoot = await this.parseFileContent(repo.owner.login, repo.name, '100SV.md');
        if (svContentRoot) {
            const svDataRoot = this.parse100SV(svContentRoot);
            if (!paper.projectId) paper.projectId = svDataRoot.projectId;
            if (!paper.researchArea) paper.researchArea = svDataRoot.researchArea;
            if (!svContentSub && svDataRoot.researchFocus && paper.description === repo.description) {
                paper.description = svDataRoot.researchFocus;
            }
        }
    }

    let titleFromProgress = null, statusFromProgress = null, priorityFromProgress = null;
    const progressContent = await this.parseFileContent(repo.owner.login, repo.name, `papers/${subpaperDir}/progress.md`);
    if (progressContent) {
      const p = this.parseProgress(progressContent);
      paper.progress = p;
      if (p.title) titleFromProgress = p.title;
      if (p.status) statusFromProgress = p.status;
      if (p.priority) priorityFromProgress = p.priority;
      paper.preprintLink = p.preprintLink; paper.publishedLink = p.publishedLink;
    }

    if (titleFromProgress) { paper.title = titleFromProgress; paper.paperName = titleFromProgress; }
    paper.status = statusFromProgress || (await this.inferStatusFromActivity(repo, `papers/${subpaperDir}/`));
    paper.priority = priorityFromProgress || 'Medium';
    return paper;
  }

  async inferStatusFromActivity(repo, specificPath = null) {
    let lastCommitDate = repo.updated_at; 
    if (specificPath && !repo.private) {
        try {
            const { data: commits } = await this.octokit.rest.repos.listCommits({
                owner: repo.owner.login, repo: repo.name, path: specificPath, per_page: 1
            });
            if (commits.length > 0 && commits[0].commit.committer?.date) lastCommitDate = commits[0].commit.committer.date;
        } catch (err) { /* Use repo.updated_at */ }
    }
    const days = Math.floor((new Date() - new Date(lastCommitDate)) / (1000*60*60*24));
    if (days < 7) return 'Active'; if (days < 30) return 'Recent';
    if (days < 90) return 'Inactive'; return 'Stale';
  }
  
  async discoverPapers() {
    console.log('🔍 Discovering paper repositories...');
    const targets = [{ type: 'user', name: this.owner }];
    let paperItemsCount = 0;
    this.papers = []; // Reset papers on each discovery run
    this.stats.recentActivity = []; // Reset recent activity

    try {
      for (const target of targets) {
        const listParams = target.type === 'org' ? { org: target.name, type: 'all', per_page: 100 } : { username: target.name, type: 'all', per_page: 100 };
        for await (const { data: reposPage } of this.octokit.paginate.iterator(
          target.type === 'org' ? this.octokit.rest.repos.listForOrg : this.octokit.rest.repos.listForUser, listParams
        )) {
          for (const repo of reposPage) {
            // Skip the hub repository itself
            if (this.repoFullName && repo.full_name.toLowerCase() === this.repoFullName.toLowerCase()) {
                // console.log(`DEBUG: Skipping self (hub repository): ${repo.full_name}`);
                continue; 
            }
            if (await this.is100SVRepository(repo)) {
              const paperList = await this.analyzePaper(repo);
              if (paperList?.length > 0) {
                this.papers.push(...paperList);
                paperItemsCount += paperList.length;
              }
            }
          }
        }
      }
      console.log(`📊 Found ${paperItemsCount} paper items.`);
      this.papers.sort((a,b) => (a.fullName||'').localeCompare(b.fullName||''));
    } catch (error) { console.error(`❌ Error discovering papers: ${error.message}`, error.stack); }
  }

  async is100SVRepository(repo) {
    // Primary: 100SV.md file in root
    try { 
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: '100SV.md', request: { retries: 0 } }); 
      return true; 
    } catch (e) { /* try next method */ }
    // Secondary: topic tag
    return repo.topics?.includes('100-scientific-visions');
  }
  
  async analyzePaper(repo) { // Orchestrates analysis of a single repo (which might contain multiple papers)
    const papersList = [];
    const subDirs = await this.findSubpapers(repo); 
    if (subDirs.length > 0) {
      for (const subDir of subDirs) {
        const data = await this.analyzeSubpaper(repo, subDir); if (data) papersList.push(data);
      }
    } else { // Treat as a single-paper repository
      const data = await this.analyzeSinglePaper(repo); if (data) papersList.push(data);
    }
    return papersList;
  }

  async findSubpapers(repo) { // Finds subdirectories in 'papers/'
    const names = [];
    try {
      // Check if 'papers' directory itself exists first
      await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers', request: { retries: 0 }});
      const { data: contents } = await this.octokit.rest.repos.getContent({ owner: repo.owner.login, repo: repo.name, path: 'papers' });
      if (Array.isArray(contents)) {
        contents.forEach(item => { if (item.type === 'dir') names.push(item.name); });
      }
    } catch (e) { /* 'papers' dir missing or error reading contents */ }
    return names;
  }

  generateStats() {
    this.stats.total = this.papers.length;
    this.stats.byStatus = {}; 
    this.stats.byPriority = {};
    const uniqueRepoWeeklyCommitsMap = new Map();

    this.papers.forEach(p => { 
        const statusKey = p.status || 'Unknown'; 
        this.stats.byStatus[statusKey] = (this.stats.byStatus[statusKey] || 0) + 1; 
        
        const priorityKey = p.priority || 'Medium'; 
        this.stats.byPriority[priorityKey] = (this.stats.byPriority[priorityKey] || 0) + 1; 
        
        // Aggregate weekly commits from main paper entries (non-subpapers)
        // or from any paper entry that has commitsLastWeek populated (usually only non-subpapers)
        if (typeof p.commitsLastWeek === 'number' && p.commitsLastWeek > 0) {
             // If a repo has multiple "main" entries (not ideal), this will take the last one.
             // A better approach if that's possible: sum if a repo has multiple non-subpaper entries.
             // For now, assumes one primary non-subpaper entry per repo for commit stats.
            uniqueRepoWeeklyCommitsMap.set(p.repoName, p.commitsLastWeek);
        }
    });
    // Sum up the unique weekly commits per repository
    this.stats.weeklyCommits = Array.from(uniqueRepoWeeklyCommitsMap.values()).reduce((sum, count) => sum + count, 0);
    
    // recentActivity is already populated during analyzeSinglePaper
    this.stats.recentActivity.sort((a, b) => b.commits - a.commits);
    this.stats.recentActivity = this.stats.recentActivity.slice(0, 10); 
  }

  async updateReadme() {
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    let dashboardUrl = (this.owner && this.repoFullName?.includes('/')) ? `https://${this.owner}.github.io/${this.repoFullName.split('/')[1]}/` : `<!-- Hub Dashboard URL Error -->`;

    let readmeContent = `# 100 Scientific Visions by Daniel Sandner

## Project Overview
A comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.

## Current Status Dashboard
*Last updated: ${timestamp}*

### Quick Stats
- 📊 **Total Papers Tracked**: ${this.stats.total}
- 🟢 **Active Projects**: ${this.stats.byStatus['Active'] || 0}
- 🟡 **In Planning**: ${this.stats.byStatus['Planning'] || 0}
- 🔴 **Stale (Needs Attention)**: ${this.stats.byStatus['Stale'] || 0}
- 📈 **This Week's Commits (Public Repos)**: ${this.stats.weeklyCommits}

### Recent Activity (Top 10 Public Repos by Weekly Commits)
`;
    if (this.stats.recentActivity.length > 0) {
      this.stats.recentActivity.forEach(act => { 
        const commitMsg = (act.lastCommit || "N/A").substring(0, 70);
        readmeContent += `- **${act.repo}**: ${act.commits} commits - "${commitMsg}${(act.lastCommit || "").length > 70 ? '...' : ''}"\n`; 
      });
    } else { 
      readmeContent += '*No recent commit activity detected in tracked public repositories.*\n'; 
    }
    readmeContent += `
## Research Areas
*Categorization based on repository topics or 'Research Area' in 100SV.md files.*

### By Status
`;
    const statuses = Object.keys(this.stats.byStatus).sort();
    if (statuses.length > 0) { 
      statuses.forEach(s => { readmeContent += `- **${s}**: ${this.stats.byStatus[s]} papers\n`; }); 
    } else { 
      readmeContent += `*No status data available.*\n`; 
    }
    readmeContent += `
### Priority Distribution
`;
    const priorities = Object.keys(this.stats.byPriority).sort((a,b) => ({High:0,Medium:1,Low:2}[a]??99) - ({High:0,Medium:1,Low:2}[b]??99));
    if (priorities.length > 0) { 
      priorities.forEach(p => { readmeContent += `- ${this.getPriorityEmoji(p)} **${p} Priority**: ${this.stats.byPriority[p]} papers\n`; }); 
    } else { 
      readmeContent += `*No priority data available.*\n`; 
    }
    readmeContent += `
## Quick Actions & Links
- [📊 Interactive Dashboard](${dashboardUrl})
- [📋 View Detailed Progress Report](./reports/detailed-progress.md)
- [🔄 Update Status Manually](../../actions) (Run "Update Project Status" workflow)

## About This System
This dashboard is automatically updated by GitHub Actions. For more information on setup, repository identification, and customization, see [SETUP.md](./setup.md).

---

*This dashboard is part of the 100 Scientific Visions initiative by Daniel Sandner.*`;
    await fs.writeFile('README.md', readmeContent);
  }

  async generateDetailedReport() {
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
            locationHint = `<br><small>(${p.fullName})</small>`;
        } else if (displayName !== p.repoName) { 
            locationHint = `<br><small>(${p.repoName})</small>`;
        }
        const links = [`<a href="${p.url}" target="_blank" title="View Paper Location">View</a>`];
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
        const repoDataForHeader = itemsInRepo[0]; 

        report += `\n### 📁 Repository: [${repoName}](${repoDataForHeader.repoUrl})\n`;
        
        const mainNonSubpaperItem = itemsInRepo.find(it => !it.isSubpaper);
        const descriptionSource = mainNonSubpaperItem ? mainNonSubpaperItem.description : repoDataForHeader.description;
        report += `- **Repo Description**: ${descriptionSource || 'N/A'}\n`;
        report += `- **Topics**: ${(repoDataForHeader.topics||[]).join(', ') || 'None'}\n`;
        report += `- **Visibility**: ${repoDataForHeader.private ? 'Private' : 'Public'}\n`;
        
        const historicalData = mainNonSubpaperItem?.historical || itemsInRepo.find(it => it.historical)?.historical;
        if (historicalData) { 
            report += `- **Created**: ${new Date(historicalData.createdAt).toLocaleDateString()} (${historicalData.age} days ago)\n`; 
            if (!repoDataForHeader.private && typeof historicalData.totalCommits3Months === 'number') { 
                report += `- **Commits (3m)**: ${historicalData.totalCommits3Months}\n`; 
            }
        }
        const weeklyCommitItem = mainNonSubpaperItem || itemsInRepo.find(it => typeof it.commitsLastWeek === 'number');
        if (weeklyCommitItem && typeof weeklyCommitItem.commitsLastWeek === 'number' && !repoDataForHeader.private) { // Only show for public
            report += `- **Weekly Commits (repo)**: ${weeklyCommitItem.commitsLastWeek}\n`;
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
            report += `    - **Description (if specific)**: ${ (p.description && p.description !== repoDataForHeader.description) ? p.description : '*(Inherits repository description or has no specific focus)*'}\n`;
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
    await fs.writeFile('reports/detailed-progress.md', report);
  }

  generateProgressBar(phases=[]) {
    const totalPhases = 12; const completed = phases.length;
    if (totalPhases === 0) return `░░░░░░░░░░ 0% (No phases)`;
    const percentage = Math.round((completed / totalPhases) * 100); 
    const filled = Math.min(10, Math.round((completed / totalPhases) * 10));
    return `${'█'.repeat(filled)}${'░'.repeat(10-filled)} ${percentage}%`;
  }
  getStatusEmoji(s) { return ({Active:'🟢',Planning:'🟡',Review:'🔵',Complete:'✅',Stale:'🔴',Inactive:'⚪',Recent:'🟠',Analysis:'🟣',Writing:'✍️','On-Hold':'⏸️',Unknown:'❓'})[s]||'❓'; }
  getPriorityEmoji(p) { return ({High:'🔴',Medium:'🟡',Low:'🟢'})[p]||'⚪'; }

  async saveData() {
    await fs.mkdir('data', { recursive: true });
    const sortedPapers = [...this.papers].sort((a,b) => (a.fullName||'').localeCompare(b.fullName||''));
    await fs.writeFile('data/papers.json', JSON.stringify(sortedPapers, null, 2));
    await fs.writeFile('data/stats.json', JSON.stringify(this.stats, null, 2));
  }

  async run() {
    console.log('🚀 Starting Scientific Visions Tracker...');
    if (!this.owner) { console.error("❌ GITHUB_OWNER missing."); process.exit(1); }
    
    await this.discoverPapers();
    this.generateStats(); 
    await this.updateReadme(); 
    await this.generateDetailedReport(); 
    await this.saveData(); 
    
    console.log('🎉 Tracker run complete!');
    console.log(`📊 Total papers processed: ${this.stats.total}.`);
    console.log(`📈 Total weekly commits for tracked public repos: ${this.stats.weeklyCommits}.`);
  }
}
(async () => { await new ScientificVisionsTracker().run(); })().catch(e => { console.error("❌ Global Error in tracker execution:", e); process.exit(1); });