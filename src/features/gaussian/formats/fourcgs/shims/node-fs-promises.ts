const unavailable = async (): Promise<never> => {
  throw new Error('4CGS browser runtime cannot access the Node filesystem.');
};

export const mkdtemp = unavailable;
export const readFile = unavailable;
export const rm = unavailable;
export const writeFile = unavailable;
