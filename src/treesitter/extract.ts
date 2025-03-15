import { Parser, Node, Tree, TreeCursor } from 'web-tree-sitter';
import { loadLanguage } from './load_language.ts';

await Parser.init();

// Check if a node is exported
function isExported(node: Node) {
  return node.previousSibling?.text === 'export';
}

export interface Comment {
  raw: string;
  jsdoc: JsDoc;
}

// Get preceding comments and parse JSDoc tags
function getPrecedingComments(node: Node): Comment | undefined {
  let comment = '';
  let prev = node.previousSibling;
  while (prev && prev.type === 'comment') {
    comment = prev.text + (comment ? '\n' + comment : '');
    prev = prev.previousSibling;
  }
  return comment ? { raw: comment, jsdoc: parseJSDoc(comment) } : undefined;
}

export interface JsDoc {
  params: {
    type: string;
    name: string;
    description: string;
  }[];
  return:
    | {
        type: string;
        description: string;
      }
    | undefined;
}

// Parse JSDoc tags from a comment block
function parseJSDoc(comment: string) {
  const paramMatches = comment.matchAll(/@param\s+(?:{(\w+(?:\|\w+)*)})?\s+(\w+)(?:\s+-\s+(.+))?/g);
  const returnMatch = comment.match(/@returns?\s+(?:{(\w+(?:\|\w+)*)})?(?:\s+-\s+(.+))?/);

  let params = Array.from(paramMatches, (match) => ({
    type: match[1] || 'unknown',
    name: match[2],
    description: match[3] || '',
  }));

  let returnVal = returnMatch
    ? {
        type: returnMatch[1] || 'unknown',
        description: returnMatch[2] || '',
      }
    : undefined;

  return {
    params,
    return: returnVal,
  };
}

export interface Function {
  signature: string;
  comment: Comment | undefined;
}

// Extract exported functions
function extractExportedFunctions(tree: Tree) {
  const functions: Function[] = [];

  function traverse(cursor: TreeCursor) {
    if (
      (cursor.currentNode.type === 'function_declaration' ||
        cursor.currentNode.type === 'method_definition') &&
      isExported(cursor.currentNode)
    ) {
      const nameNode = cursor.currentNode.childForFieldName('name');
      const paramNode = cursor.currentNode.childForFieldName('parameters');
      const returnTypeNode = cursor.currentNode.childForFieldName('return_type');
      const name = nameNode?.text || 'anonymous';
      const params = paramNode?.text || '()';

      if (name === 'complexReturnType') {
        console.log(returnTypeNode?.children?.map((c) => c?.type));
      }

      const returnType = returnTypeNode ? getActualType(returnTypeNode)?.text : '';
      const signature = `function ${name}${params} : ${returnType}`;
      const comment = getPrecedingComments(cursor.currentNode);
      functions.push({ signature, comment });
    }

    let walked = cursor.gotoFirstChild();
    if (walked) {
      while (walked) {
        traverse(cursor);
        walked = cursor.gotoNextSibling();
      }

      cursor.gotoParent();
    }
  }

  const rootNode = tree.walk();

  traverse(rootNode);
  return functions;
}

export interface Variable {
  signature: string;
  keyword: string;
  name: string;
  type: string;
  value: string;
}

function getActualType(typeNode: Node | null) {
  console.log(typeNode?.children?.map((c) => c?.type));
  return typeNode?.children?.find(
    (c) =>
      c?.type === 'type_identifier' ||
      c?.type === 'predefined_type' ||
      c?.type === 'generic_type' ||
      c?.type === 'union_type' ||
      c?.type === 'intersection_type' ||
      c?.type === 'conditional_type'
  );
}

// Extract exported variables
function extractExportedVariables(tree: Tree) {
  const variables: Variable[] = [];
  const rootNode = tree.rootNode;

  function traverse(node: Node) {
    if (
      (node.type === 'lexical_declaration' || node.type === 'variable_declaration') &&
      isExported(node)
    ) {
      for (let decl of node.namedChildren) {
        if (decl?.type === 'variable_declarator') {
          const nameNode = decl.childForFieldName('name');
          const valueNode = decl.childForFieldName('value');
          const typeNode = decl.childForFieldName('type');
          const actualType = getActualType(typeNode);

          const name = nameNode?.text || '';
          const type = actualType?.text || '';
          const value = valueNode?.text || '';
          const keyword =
            node.type === 'lexical_declaration' && node.firstChild ? node.firstChild.text : 'var';
          variables.push({
            signature: node.text, // `${keyword} ${name}: ${type} = ${value}`,
            keyword,
            name,
            type,
            value,
          });
        }
      }
    }
    for (let child of node.children) {
      if (child) {
        traverse(child);
      }
    }
  }

  traverse(rootNode);
  return variables;
}

export interface Class {
  signature: string;
  comment: Comment | undefined;
  methods: Method[];
}

export interface Method {
  signature: string;
  comment: Comment | undefined;
}

// Extract exported classes with method signatures
function extractExportedClasses(tree: Tree) {
  const classes: Class[] = [];
  const rootNode = tree.rootNode;

  function getMethodSignature(methodNode: Node) {
    const nameNode = methodNode.childForFieldName('name');
    const paramNode = methodNode.childForFieldName('parameters');
    const returnTypeNode = methodNode.childForFieldName('return_type');
    const name = nameNode ? nameNode.text : 'anonymous';
    const params = paramNode ? paramNode.text : '()';
    const returnType = returnTypeNode ? `: ${returnTypeNode.text}` : '';
    const comment = getPrecedingComments(methodNode);
    return { signature: `${name}${params}${returnType}`, comment };
  }

  function traverse(node: Node) {
    if (node.type === 'class_declaration' && isExported(node)) {
      const nameNode = node.childForFieldName('name');
      const heritageNode = node.childForFieldName('heritage');
      const bodyNode = node.childForFieldName('body');
      const name = nameNode?.text || 'anonymous';
      const heritage = heritageNode?.text || '';
      const signature = `class ${name}${heritage}`;
      const comment = getPrecedingComments(node);
      const methods = [];

      if (bodyNode) {
        for (let child of bodyNode.namedChildren) {
          if (child?.type === 'method_definition') {
            methods.push(getMethodSignature(child));
          }
        }
      }

      classes.push({ signature, comment, methods });
    }
    for (let child of node.children) {
      if (child) {
        traverse(child);
      }
    }
  }

  traverse(rootNode);
  return classes;
}

export interface TsInterface {
  signature: string;
  name: string;
  body: string;
  comment: Comment | undefined;
}

// Extract TypeScript interfaces
function extractInterfaces(tree: Tree) {
  const interfaces: TsInterface[] = [];
  const rootNode = tree.rootNode;

  function traverse(node: Node) {
    if (node.type === 'interface_declaration' && isExported(node)) {
      const nameNode = node.childForFieldName('name');
      const bodyNode = node.childForFieldName('body');
      const name = nameNode ? nameNode.text : 'unknown';
      const body = bodyNode?.text || '{}';
      const signature = `interface ${name}${body}`;
      const comment = getPrecedingComments(node);
      interfaces.push({ signature, name, body, comment });
    }
    for (let child of node.children) {
      traverse(child);
    }
  }

  traverse(rootNode);
  return interfaces;
}

export interface TsType {
  signature: string;
  comment: Comment | undefined;
}

// Extract TypeScript type aliases
function extractTypeAliases(tree: Tree) {
  const types: TsType[] = [];
  const rootNode = tree.rootNode;

  function traverse(node: Node) {
    if (node.type === 'type_alias_declaration' && isExported(node)) {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      const name = nameNode ? nameNode.text : 'unknown';
      const value = valueNode ? ` = ${valueNode.text}` : '';
      const signature = `type ${name}${value}`;
      const comment = getPrecedingComments(node);
      types.push({ signature, comment });
    }
    for (let child of node.children) {
      traverse(child);
    }
  }

  traverse(rootNode);
  return types;
}

// Extract all comments
function extractComments(tree: Tree) {
  const comments: string[] = [];
  const rootNode = tree.rootNode;

  function traverse(node: Node) {
    if (node.type === 'comment') {
      comments.push(node.text);
    }
    for (let child of node.children) {
      traverse(child);
    }
  }

  traverse(rootNode);
  return comments;
}

// Extract imported modules
function extractImports(tree: Tree) {
  const imports: string[] = [];
  const rootNode = tree.rootNode;

  function traverse(node: Node) {
    if (node.type === 'import_statement') {
      const sourceNode = node.childForFieldName('source');
      if (sourceNode) {
        const moduleName = sourceNode.text.replace(/['"]/g, '');
        imports.push(moduleName);
      }
    }
    for (let child of node.children) {
      traverse(child);
    }
  }

  traverse(rootNode);
  return imports;
}

export async function parseFile(filename: string, code: string) {
  const parser = new Parser();

  let language: string;
  if (/.svelte(.(ts|js))?$/.test(filename)) {
    language = 'svelte';
  } else if (filename.endsWith('.ts') || filename.endsWith('.js')) {
    language = 'typescript';
  } else {
    return null;
  }

  const languageModule = await loadLanguage(language);
  parser.setLanguage(languageModule);

  const tree = parser.parse(code);

  // Run the extraction
  const exportedFunctions = extractExportedFunctions(tree);
  const exportedVariables = extractExportedVariables(tree);
  const exportedClasses = extractExportedClasses(tree);
  const interfaces = extractInterfaces(tree);
  const typeAliases = extractTypeAliases(tree);
  const allComments = extractComments(tree);
  const importedModules = extractImports(tree);

  return {
    exportedFunctions,
    exportedVariables,
    exportedClasses,
    interfaces,
    typeAliases,
    allComments,
    importedModules,
  };
}

// Output results with JSDoc details
export function printJSDoc(comment: Comment, indent = '') {
  if (!comment) return;
  console.log(`${indent}Comment: ${comment.raw}`);
  if (comment.jsdoc.params.length > 0) {
    console.log(`${indent}JSDoc Params:`);
    comment.jsdoc.params.forEach((p) =>
      console.log(`${indent}  - ${p.name}: ${p.type}${p.description ? ` - ${p.description}` : ''}`)
    );
  }
  if (comment.jsdoc.return) {
    console.log(
      `${indent}JSDoc Return: ${comment.jsdoc.return.type}${comment.jsdoc.return.description ? ` - ${comment.jsdoc.return.description}` : ''}`
    );
  }
}
