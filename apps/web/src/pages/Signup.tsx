import axios from "axios";
import { MouseEvent } from "react";

async function signUp(event: MouseEvent<HTMLButtonElement>) {
  event.preventDefault();
  await axios
    .post("http://localhost:4000/auth/signup", {
      username: "frolleks",
      email: "email@example.com",
      password: "kjdhsajdjusayewqiegweuwqe",
    })
    .then(
      (response) => {
        console.log(response);
      },
      (error) => {
        console.error(error);
      }
    );
}

function Signup() {
  return (
    <>
      <button
        className="py-2 px-4 bg-zinc-800 text-white rounded-md m-2"
        onClick={signUp}
      >
        Sign Up
      </button>
    </>
  );
}

export default Signup;
