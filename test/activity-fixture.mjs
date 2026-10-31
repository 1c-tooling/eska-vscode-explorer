import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjectGroupingSource, descriptor } from './fixture.mjs';
import { createLanguageSource } from './language-fixture.mjs';

/** Every file and private activity store belongs to this native acceptance stand. */
export async function createActivitySource(fixture, owner) {
  const {members}=await createProjectGroupingSource(fixture);
  await rm(fixture.source,{recursive:true});
  const language=await createLanguageSource(members.base);
  for(const [name,member] of Object.entries(members)) {
    if(member.type==='configuration'||member.type==='extension') {
      const file=join(member.source,'Configuration.xml');
      const property=member.type==='extension'?'ConfigurationExtensionCompatibilityMode':'CompatibilityMode';
      await writeFile(file,(await readFile(file,'utf8')).replace('</Properties>',`<${property}>Version8_3_27</${property}></Properties>`));
    } else {
      const objectName='Проект_'+name.replaceAll('-','_'), original=join(member.source,'Тест.xml');
      const target=join(member.source,objectName+'.xml');
      await writeFile(target,(await readFile(original,'utf8')).replace('<Name>Тест</Name>',`<Name>${objectName}</Name>`));
      await rm(original);await rename(join(member.source,'Тест'),join(member.source,objectName));
      member.module=join(member.source,objectName,'Ext','ObjectModule.bsl');member.descriptor=target;
      await writeFile(member.module,'Функция Локальная(Значение) Экспорт\n    Возврат Значение;\nКонецФункции\n\nПроцедура Использовать()\n    А = Обмен.Проверка(1);\n    Б = РасширениеAPI.Проверка(1);\n    В = Локальная(1);\nКонецПроцедуры\n');
    }
  }
  const api=members['extension-one'], apiFile=join(api.source,'CommonModules','РасширениеAPI','Ext','Module.bsl');
  const root=join(api.source,'Configuration.xml');
  await writeFile(root,(await readFile(root,'utf8')).replace('<ChildObjects>','<ChildObjects><CommonModule>РасширениеAPI</CommonModule>'));
  await mkdir(join(api.source,'CommonModules','РасширениеAPI','Ext'),{recursive:true});
  await writeFile(join(api.source,'CommonModules','РасширениеAPI.xml'),descriptor('CommonModule','РасширениеAPI','', '<Global>false</Global><Server>true</Server><ExternalConnection>true</ExternalConnection><ClientManagedApplication>false</ClientManagedApplication><ClientOrdinaryApplication>false</ClientOrdinaryApplication><ServerCall>false</ServerCall><Privileged>false</Privileged><ReturnValuesReuse>DontUse</ReturnValuesReuse>'));
  await writeFile(apiFile,'Функция Проверка(Значение) Экспорт\n    Возврат Значение;\nКонецФункции\n');
  const manifest="[workspace]\n[analysis]\ndefault_application='app'\n[workspace.members.app]\nconfiguration='members/base'\nextensions=[{path='members/extension-one'},{path='members/extension-two',depends_on=['extension-one']}]\nexternal_objects=['members/report-one','members/processing-one','members/processing-two']\n[workspace.members.other]\nconfiguration='members/base'\nextensions=[{path='members/extension-one'}]\nexternal_objects=['members/report-two']\n[tools.bsl-analyzer.diagnostics.parameters]\nLineLength=false\n";
  await writeFile(join(fixture.root,'eska.toml'),manifest);
  const instrumented = process.platform !== 'win32';
  let analyzer = process.env.ESKA_TEST_ANALYZER_BINARY;
  if (instrumented) {
    analyzer = join(owner,'native-activity-analyzer');
    await writeFile(analyzer,await readFile(new URL('./activity-analyzer.py',import.meta.url)),{mode:0o755});
  }
  if (instrumented && process.env.ESKA_HOST_ACTIVITY_CANCEL === '1') await writeFile(join(fixture.root,'.activity-validation-hold'),'hold');
  const configDir=join(owner,'private-machine');await mkdir(configDir);
  return {members,baseDefinition:language.file,extensionDefinition:apiFile,configDir,analyzer,instrumented};
}
