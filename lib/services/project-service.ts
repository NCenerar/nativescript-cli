import * as constants from "../constants";
import * as path from "path";
import simpleGit, { SimpleGit } from "simple-git";
import { exported } from "../common/decorators";
import { Hooks } from "../constants";
import { performanceLog } from "../common/decorators";
import {
	IProjectService,
	IProjectDataService,
	IProjectTemplatesService,
	ICreateProjectData,
	IProjectSettings,
	IProjectCreationSettings,
	ITemplateData,
	IProjectConfigService,
} from "../definitions/project";
import {
	INodePackageManager,
	IOptions,
	IProjectNameService,
	IStaticConfig,
} from "../declarations";
import {
	IHooksService,
	IErrors,
	IFileSystem,
	IProjectHelper,
	IChildProcess,
} from "../common/declarations";
import * as _ from "lodash";
import { injector } from "../common/yok";
import { ITempService } from "../definitions/temp-service";

export class ProjectService implements IProjectService {
	constructor(
		private $options: IOptions,
		private $hooksService: IHooksService,
		private $packageManager: INodePackageManager,
		private $errors: IErrors,
		private $fs: IFileSystem,
		private $logger: ILogger,
		private $pacoteService: IPacoteService,
		private $projectDataService: IProjectDataService,
		private $projectConfigService: IProjectConfigService,
		private $projectHelper: IProjectHelper,
		private $projectNameService: IProjectNameService,
		private $projectTemplatesService: IProjectTemplatesService,
		private $tempService: ITempService,
		private $staticConfig: IStaticConfig,
		private $childProcess: IChildProcess
	) {}

	public async validateProjectName(opts: {
		projectName: string;
		force: boolean;
		pathToProject: string;
	}): Promise<string> {
		let projectName = opts.projectName;
		if (!projectName) {
			this.$errors.failWithHelp(
				"You must specify <App name> when creating a new project."
			);
		}

		projectName = await this.$projectNameService.ensureValidName(projectName, {
			force: opts.force,
		});
		const projectDir = this.getValidProjectDir(opts.pathToProject, projectName);
		if (this.$fs.exists(projectDir) && !this.$fs.isEmptyDir(projectDir)) {
			this.$errors.fail("Path already exists and is not empty %s", projectDir);
		}

		return projectName;
	}

	@exported("projectService")
	@performanceLog()
	public async createProject(
		projectOptions: IProjectSettings
	): Promise<ICreateProjectData> {
		const projectName = await this.validateProjectName({
			projectName: projectOptions.projectName,
			force: projectOptions.force,
			pathToProject: projectOptions.pathToProject,
		});
		const projectDir = this.getValidProjectDir(
			projectOptions.pathToProject,
			projectName
		);

		this.$fs.createDirectory(projectDir);

		const appId =
			projectOptions.appId ||
			this.$projectHelper.generateDefaultAppId(
				projectName,
				constants.DEFAULT_APP_IDENTIFIER_PREFIX
			);
		this.$logger.trace(
			`Creating a new NativeScript project with name ${projectName} and id ${appId} at location ${projectDir}`
		);

		const projectCreationData = await this.createProjectCore({
			template: projectOptions.template,
			projectDir,
			ignoreScripts: projectOptions.ignoreScripts,
			appId: appId,
			projectName,
		});

		// can pass --no-git to skip creating a git repo
		// useful in monorepos where we're creating
		// sub projects in an existing git repo.
		if (this.$options.git) {
			try {
				if (!this.$options.force) {
					const git: SimpleGit = simpleGit(projectDir);
					if (await git.checkIsRepo()) {
						// throwing here since we're catching below.
						throw new Error("Already part of a git repository.");
					}
				}
				await this.$childProcess.exec(`git init ${projectDir}`);
				await this.$childProcess.exec(`git -C ${projectDir} add --all`);
				await this.$childProcess.exec(
					`git -C ${projectDir} commit --no-verify -m "init"`
				);
			} catch (err) {
				this.$logger.trace(
					"Unable to initialize git repository. Error is: ",
					err
				);
			}
		}

		this.$logger.trace(`Project ${projectName} was successfully created.`);

		return projectCreationData;
	}

	@exported("projectService")
	public isValidNativeScriptProject(pathToProject?: string): boolean {
		try {
			const projectData = this.$projectDataService.getProjectData(
				pathToProject
			);

			return (
				!!projectData &&
				!!projectData.projectDir &&
				!!(
					projectData.projectIdentifiers.ios &&
					projectData.projectIdentifiers.android
				)
			);
		} catch (e) {
			return false;
		}
	}

	private getValidProjectDir(
		pathToProject: string,
		projectName: string
	): string {
		const selectedPath = path.resolve(pathToProject || ".");
		const projectDir = path.join(selectedPath, projectName);

		return projectDir;
	}

	private async createProjectCore(
		projectCreationSettings: IProjectCreationSettings
	): Promise<ICreateProjectData> {
		const {
			template,
			projectDir,
			appId,
			projectName,
			ignoreScripts,
		} = projectCreationSettings;

		try {
			const templateData = await this.$projectTemplatesService.prepareTemplate(
				template,
				projectDir
			);

			await this.extractTemplate(projectDir, templateData);

			this.alterPackageJsonData(projectCreationSettings);
			this.$projectConfigService.writeDefaultConfig(projectDir, appId);

			await this.ensureAppResourcesExist(projectDir);

			// Install devDependencies and execute all scripts:
			await this.$packageManager.install(projectDir, projectDir, {
				disableNpmInstall: false,
				frameworkPath: null,
				ignoreScripts,
			});
		} catch (err) {
			this.$fs.deleteDirectory(projectDir);
			throw err;
		}

		await this.$hooksService.executeAfterHooks(Hooks.createProject, {
			hookArgs: projectCreationSettings,
		});

		return { projectName, projectDir };
	}

	@performanceLog()
	private async extractTemplate(
		projectDir: string,
		templateData: ITemplateData
	): Promise<void> {
		this.$fs.ensureDirectoryExists(projectDir);

		const fullTemplateName = templateData.version
			? `${templateData.templateName}@${templateData.version}`
			: templateData.templateName;
		await this.$pacoteService.extractPackage(fullTemplateName, projectDir);
	}

	@performanceLog()
	private async ensureAppResourcesExist(projectDir: string): Promise<void> {
		const projectData = this.$projectDataService.getProjectData(projectDir);
		const appResourcesDestinationPath = projectData.getAppResourcesDirectoryPath(
			projectDir
		);

		if (!this.$fs.exists(appResourcesDestinationPath)) {
			this.$logger.trace(
				"Project does not have App_Resources - fetching from default template."
			);
			this.$fs.createDirectory(appResourcesDestinationPath);
			const tempDir = await this.$tempService.mkdirSync("ns-default-template");
			// the template installed doesn't have App_Resources -> get from a default template
			await this.$pacoteService.extractPackage(
				constants.RESERVED_TEMPLATE_NAMES["default"],
				tempDir
			);
			const templateProjectData = this.$projectDataService.getProjectData(
				tempDir
			);
			const templateAppResourcesDir = templateProjectData.getAppResourcesDirectoryPath(
				tempDir
			);
			this.$fs.copyFile(
				path.join(templateAppResourcesDir, "*"),
				appResourcesDestinationPath
			);
		}
	}

	@performanceLog()
	private alterPackageJsonData(
		projectCreationSettings: IProjectCreationSettings
	): void {
		const { projectDir, projectName } = projectCreationSettings;
		const projectFilePath = path.join(
			projectDir,
			this.$staticConfig.PROJECT_FILE_NAME
		);

		let packageJsonData = this.$fs.readJson(projectFilePath);

		// clean up keys from the template package.json that we don't care about.
		Object.keys(packageJsonData).forEach((key) => {
			if (
				key.startsWith("_") ||
				constants.TemplatesV2PackageJsonKeysToRemove.includes(key)
			) {
				delete packageJsonData[key];
			}
		});

		// this is used to ensure the order of keys is consistent, the blanks are filled in from the template
		const packageJsonSchema = {
			name: projectName,
			main: "",
			version: "1.0.0",
			private: true,
			dependencies: {},
			devDependencies: {},
			// anythign else would go below
		};

		packageJsonData = Object.assign(packageJsonSchema, packageJsonData);

		this.$fs.writeJson(projectFilePath, packageJsonData);
	}
}

injector.register("projectService", ProjectService);
