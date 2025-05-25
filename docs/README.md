# Prototype for "100 Scientific Visions" project management system

# 100 Scientific Visions by Daniel Sandner

## Project Overview
A comprehensive research initiative encompassing 100+ scientific papers across multiple research programs and topics.

## Current Status Dashboard
*Last updated: 2025-05-24 10:30 UTC*

### Quick Stats
- 📊 **Total Papers**: 0 discovered
- 🟢 **Active Projects**: 0
- 🟡 **In Planning**: 0
- 🔴 **Need Attention**: 0
- 📈 **This Week's Commits**: 0

### Recent Activity
*No activity detected yet - run the update workflow to populate*

## Research Areas
*Auto-generated based on repository topics*

### By Status
- **Planning Phase**: 0 papers
- **Active Research**: 0 papers
- **Analysis Phase**: 0 papers
- **Writing Phase**: 0 papers
- **Under Review**: 0 papers
- **Published**: 0 papers

### Priority Distribution
- 🔴 **High Priority**: 0 papers
- 🟡 **Medium Priority**: 0 papers
- 🟢 **Low Priority**: 0 papers

## Quick Actions
- [📋 View Detailed Progress Report](./reports/detailed-progress.md)
- [📊 Weekly Summary](./reports/weekly-summary.md)
- [📈 Monthly Highlights](./reports/monthly-highlights.md)
- [🔄 Update Status](../../actions) (Run "Update Project Status" workflow)

## Repository Management
- **Naming Convention**: `paper-[topic]-[year]` or descriptive name
- **Required Files**: README.md, progress.md in papers/ folder
- **Topics**: Use GitHub topics for categorization
- **Status Tracking**: Via standardized progress.md files

---

*This dashboard is automatically updated by GitHub Actions. For manual updates or issues, check the [workflow logs](../../actions).*


## What You Get

**📊 Documentation Hub** - A central repository that automatically aggregates and displays:
- Real-time status dashboard of all papers
- Progress tracking across repositories
- Weekly activity summaries
- Detailed progress reports

**🤖 GitHub App/Automation** - A custom GitHub Actions workflow that:
- Automatically discovers all repositories with `papers/` folders
- Reads progress.md files to track status
- Monitors commit activity (public repos) and basic metadata (private repos)
- Generates comprehensive reports daily

**📝 Standardized Progress Tracking** - A template system that:
- Uses separate `progress.md` files (keeps README.md clean)
- Supports both manual status updates and automated inference
- Works with private repositories (limited tracking)

## Key Features

✅ **Completely Free** - Runs entirely on GitHub's free tier
✅ **Private Repo Support** - Tracks commit activity and metadata (not content)
✅ **Automatic Discovery** - Finds new paper repositories automatically
✅ **Manual Override** - Can be triggered on-demand
✅ **Scalable** - Handles 100+ repositories efficiently
✅ **Customizable** - Easy to modify tracking criteria and reports

## How It Works

1. **Daily Automation**: Scans all your repositories for `papers/` folders
2. **Smart Analysis**: Reads `progress.md` files or infers status from activity
3. **Dashboard Updates**: Automatically updates the central README with current status
4. **Detailed Reports**: Generates comprehensive progress reports
5. **Activity Tracking**: Monitors weekly commits and recent changes

## Private Repository Handling

For private repos, the system tracks:
- Repository metadata (last updated, description)
- Commit frequency (not content/messages)  
- Progress status from `progress.md` files
- Basic activity patterns

This gives you oversight without exposing sensitive research content.

The setup is straightforward - just create the hub repository, add the files, and run the workflow. It will immediately start discovering and tracking all your paper repositories!

Would you like me to explain any specific part in more detail, or shall I create additional components like visual dashboards or custom report formats?